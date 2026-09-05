import { Link, useLocation } from "wouter";
import { HardDrive, Activity, FolderGit2, Cpu, Play } from "lucide-react";
import { cn } from "@/lib/utils";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", icon: HardDrive, label: "Workspace" },
    { href: "/jobs", icon: FolderGit2, label: "Job History" },
    { href: "/automated-drawing", icon: Play, label: "Automated Run" },
    { href: "/machine", icon: Cpu, label: "Machine Controller" },
  ];

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <div className="flex w-16 flex-shrink-0 flex-col border-r border-border bg-card md:w-64">
        <div className="flex h-16 items-center border-b border-border px-3 md:px-6">
          <Activity className="mr-0 h-5 w-5 shrink-0 text-primary md:mr-3" />
          <span className="hidden font-mono text-lg font-bold tracking-tight md:inline">DMHC-EM</span>
        </div>
        
        <nav aria-label="Primary navigation" className="flex-1 space-y-1 overflow-y-auto p-2 md:p-4">
          <div className="mb-4 hidden px-2 text-xs font-mono uppercase tracking-wider text-muted-foreground md:block">Navigation</div>
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link 
                key={item.href} 
                href={item.href}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                title={item.label}
                className={cn(
                  "flex items-center justify-center rounded-sm px-3 py-3 font-mono text-sm transition-colors md:justify-start md:py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  isActive 
                    ? "bg-primary/15 text-primary font-bold shadow-sm"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <item.icon className="mr-0 h-5 w-5 shrink-0 md:mr-3 md:h-4 md:w-4" />
                <span className="hidden md:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border bg-muted/20 p-3 md:p-4">
          <div className="flex items-center justify-center text-xs font-mono text-muted-foreground md:justify-start" data-testid="status-system-online">
            <div className="mr-0 h-2 w-2 rounded-full bg-chart-3 md:mr-2 shadow-[0_0_8px_hsla(var(--chart-3)/0.8)]" />
            <span className="hidden md:inline">System Online</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <main className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
