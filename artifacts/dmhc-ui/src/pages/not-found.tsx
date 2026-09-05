import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center p-6 text-center sm:p-8">
      <AlertCircle className="w-16 h-16 text-destructive mb-6" />
      <p className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.2em] text-destructive">Navigation fault</p>
      <h1 className="mb-2 text-4xl font-mono font-bold tracking-tight" data-testid="text-not-found-code">404</h1>
      <p className="text-xl font-mono text-muted-foreground mb-8">Page not found</p>
      <Link href="/" aria-label="Return to Workspace" data-testid="link-return-workspace" className={cn(buttonVariants({ size: "lg" }), "font-mono")}>
        Return to Workspace
      </Link>
    </div>
  );
}
