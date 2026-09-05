from local_desktop_app import LocalProjectLauncher

if __name__ == "__main__":
    app = LocalProjectLauncher()
    app.start_services()
    try:
        while True:
            import time
            time.sleep(2)
    except KeyboardInterrupt:
        app.shutdown()
