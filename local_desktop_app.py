import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent


class LocalProjectLauncher:
    def __init__(self):
        self.processes = []
        self.stop_event = threading.Event()
        self.agent_token = None

    def log(self, message: str):
        print(message)

    def is_port_in_use(self, port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            return s.connect_ex(("127.0.0.1", port)) == 0

    def kill_port(self, port: int):
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", f"(Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }})"],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                self.log(f"Cleared stale process on port {port}.")
        except Exception:
            pass

    def find_pnpm(self):
        pnpm = shutil.which("pnpm")
        if pnpm:
            return pnpm
        corepack = shutil.which("corepack")
        if corepack:
            return corepack
        raise RuntimeError(
            "pnpm not found. Install Node.js and pnpm first, then run this file again."
        )

    def _append_windows_tool_dirs(self, env):
        if os.name != "nt":
            return env

        candidate_dirs = []
        for base in (
            os.environ.get("JAVA_HOME"),
            os.environ.get("MAVEN_HOME"),
            r"C:\Program Files\Java",
            r"C:\Program Files\Eclipse Adoptium",
            r"C:\Program Files\ApacheMaven",
            r"C:\Program Files\Common Files\Oracle\Java",
        ):
            if base and os.path.isdir(base):
                candidate_dirs.append(base)
                if os.path.basename(base).lower() == "java":
                    continue
                candidate_dirs.append(os.path.join(base, "bin"))

        for root in (r"C:\Program Files\Java", r"C:\Program Files\Eclipse Adoptium", r"C:\Program Files\ApacheMaven"):
            if os.path.isdir(root):
                try:
                    for item in os.listdir(root):
                        full = os.path.join(root, item)
                        if os.path.isdir(full):
                            candidate_dirs.append(full)
                            candidate_bin = os.path.join(full, "bin")
                            if os.path.isdir(candidate_bin):
                                candidate_dirs.append(candidate_bin)
                except OSError:
                    pass

        existing = env.get("PATH", "")
        paths = [p for p in candidate_dirs if p and p not in existing.split(os.pathsep)]
        if paths:
            env["PATH"] = os.pathsep.join(paths + [existing]) if existing else os.pathsep.join(paths)
        return env

    def find_java_and_maven(self):
        java_path = shutil.which("java") or shutil.which("java.exe")
        mvn_path = shutil.which("mvn") or shutil.which("mvn.cmd") or shutil.which("mvn.exe")

        if not java_path:
            for base in (
                os.environ.get("JAVA_HOME"),
                r"C:\Program Files\Java",
                r"C:\Program Files\Eclipse Adoptium",
                r"C:\Program Files\Common Files\Oracle\Java",
            ):
                if base:
                    candidate = os.path.join(base, "bin", "java.exe")
                    if os.path.isfile(candidate):
                        java_path = candidate
                        break
                    candidate = os.path.join(base, "bin", "java")
                    if os.path.isfile(candidate):
                        java_path = candidate
                        break

        if not mvn_path:
            for base in (
                os.environ.get("MAVEN_HOME"),
                r"C:\Program Files\ApacheMaven",
            ):
                if base:
                    candidate = os.path.join(base, "bin", "mvn.cmd")
                    if os.path.isfile(candidate):
                        mvn_path = candidate
                        break
                    candidate = os.path.join(base, "bin", "mvn")
                    if os.path.isfile(candidate):
                        mvn_path = candidate
                        break

        return java_path, mvn_path

    def ensure_dependencies(self):
        if (PROJECT_ROOT / "node_modules").exists():
            self.log("Dependencies already installed; skipping reinstall.")
            return True

        self.log("Installing workspace dependencies for the first time...")
        pnpm = self.find_pnpm()
        cmd = [pnpm, "install"] if pnpm.endswith("pnpm") else [pnpm, "pnpm", "install"]
        result = subprocess.run(cmd, cwd=str(PROJECT_ROOT), text=True)
        if result.returncode != 0:
            self.log("\nInstall failed.")
            self.log("Run this once manually:")
            self.log("  pnpm install")
            self.log("  pnpm approve-builds")
            self.log("Then run this launcher again.\n")
            return False
        return True

    def start_process(self, name: str, command: list[str], env: dict | None = None, cwd: str | None = None):
        self.log(f"Starting {name}: {' '.join(command)}")
        process = subprocess.Popen(
            command,
            cwd=str(cwd or PROJECT_ROOT),
            env=env or os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            shell=False,
        )
        self.processes.append((name, process))
        threading.Thread(
            target=self.tail_output,
            args=(name, process),
            daemon=True,
        ).start()
        return process

    def tail_output(self, name: str, process: subprocess.Popen):
        if not process.stdout:
            return
        for line in process.stdout:
            text = line.rstrip()
            if text:
                print(f"[{name}] {text}")
                if "Agent token:" in text:
                    self.agent_token = text.split("Agent token:", 1)[1].strip()
                    print(f"\nFINAL AGENT TOKEN: {self.agent_token}\n")
            if self.stop_event.is_set():
                break

    def build_api(self):
        api_dir = PROJECT_ROOT / "artifacts" / "api-server"
        if not api_dir.exists():
            raise FileNotFoundError(f"Missing API folder: {api_dir}")

        self.log("Building API server...")
        pnpm = self.find_pnpm()
        build_cmd = [pnpm, "--dir", str(api_dir), "run", "build"]
        result = subprocess.run(build_cmd, cwd=str(PROJECT_ROOT), text=True)
        if result.returncode != 0:
            raise RuntimeError("API build failed.")

    def start_api(self):
        if self.is_port_in_use(25309):
            self.log("Port 25309 already in use; skipping API start.")
            return None

        self.build_api()
        api_env = os.environ.copy()
        api_env["PORT"] = "25309"
        api_env["NODE_ENV"] = "development"
        api_dir = PROJECT_ROOT / "artifacts" / "api-server"
        return self.start_process(
            "API",
            ["node", "--enable-source-maps", str(api_dir / "dist" / "index.mjs")],
            env=api_env,
            cwd=str(api_dir),
        )

    def start_frontend(self):
        if self.is_port_in_use(25308):
            self.log("Port 25308 already in use; skipping frontend start.")
            return None

        ui_dir = PROJECT_ROOT / "artifacts" / "dmhc-ui"
        ui_env = os.environ.copy()
        ui_env["PORT"] = "25308"
        ui_env["BASE_PATH"] = "/"
        ui_env["NODE_ENV"] = "development"
        return self.start_process(
            "FRONTEND",
            [self.find_pnpm(), "exec", "vite", "--config", "vite.config.ts", "--host", "0.0.0.0", "--port", "25308"],
            env=ui_env,
            cwd=str(ui_dir),
        )

    def start_machine_agent(self):
        agent_dir = PROJECT_ROOT / "machine-agent"
        if not agent_dir.exists():
            self.log("Machine agent folder not found; skipping local agent.")
            return None

        if self.is_port_in_use(18888):
            self.log("Port 18888 already in use. Clearing stale local agent process...")
            self.kill_port(18888)
            time.sleep(1)

        java_path, mvn_path = self.find_java_and_maven()
        if not (java_path and mvn_path):
            self.log("Machine Agent skipped: Java/Maven not found in PATH or standard install locations.")
            return None

        agent_env = self._append_windows_tool_dirs(os.environ.copy())
        java_cmd = [java_path, "-jar", str(agent_dir / "target" / "dmhc-machine-agent.jar")]
        jar_path = agent_dir / "target" / "dmhc-machine-agent.jar"
        if jar_path.exists():
            self.log("Machine agent jar already exists; skipping rebuild.")
            return self.start_process(
                "AGENT",
                java_cmd,
                env=agent_env,
                cwd=str(agent_dir),
            )

        self.log("Building Machine Agent...")
        build = subprocess.run([mvn_path, "-f", str(agent_dir / "pom.xml"), "clean", "package"], cwd=str(PROJECT_ROOT), text=True, env=agent_env)
        if build.returncode != 0:
            self.log("Machine agent build failed. Continuing without it.")
            return None
        return self.start_process(
            "AGENT",
            java_cmd,
            env=agent_env,
            cwd=str(agent_dir),
        )

    def start_services(self):
        self.log("=== CNC Local Launcher ===")
        self.log(f"Project root: {PROJECT_ROOT}")

        if not self.ensure_dependencies():
            return False

        for port in (25308, 25309):
            if self.is_port_in_use(port):
                self.log(f"Port {port} already in use. Clearing stale local process...")
                self.kill_port(port)
                time.sleep(1)

        if self.is_port_in_use(18888):
            self.log("Port 18888 already in use. Clearing stale local agent process...")
            self.kill_port(18888)
            time.sleep(1)

        self.start_api()
        self.start_frontend()
        self.start_machine_agent()

        time.sleep(5)
        try:
            webbrowser.open("http://127.0.0.1:25308/", new=2)
        except Exception:
            pass

        self.log("\nLocal services started.")
        self.log("Frontend: http://127.0.0.1:25308/")
        self.log("API:      http://127.0.0.1:25309")
        if self.agent_token:
            self.log(f"FINAL AGENT TOKEN: {self.agent_token}")
        else:
            self.log("FINAL AGENT TOKEN: not generated yet.")
        self.log("Press Ctrl+C in this window to stop everything.\n")
        return True

    def shutdown(self):
        self.stop_event.set()
        for name, process in self.processes:
            if process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=10)
                    self.log(f"Stopped {name}.")
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
        self.log("All launched processes have been stopped.")
        raise SystemExit(0)


if __name__ == "__main__":
    launcher = LocalProjectLauncher()
    signal.signal(signal.SIGINT, lambda signum, frame: launcher.shutdown())

    try:
        if not launcher.start_services():
            sys.exit(1)

        while True:
            time.sleep(2)
            alive = [p for _, p in launcher.processes if p.poll() is None]
            if not alive:
                break
    except KeyboardInterrupt:
        launcher.shutdown()
    except SystemExit:
        raise
