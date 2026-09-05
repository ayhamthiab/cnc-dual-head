import { useListJobs } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { format } from "date-fns";
import { Play, Loader2, FileCheck2, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AutomatedDrawingList() {
  const { data: jobs, isLoading } = useListJobs();

  // Only consider successfully generated jobs
  const successfulJobs = jobs?.filter(job => job.status === "success") || [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:space-y-8 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary flex items-center gap-2">
          <Cpu className="w-4 h-4" /> Operator Cockpit
        </p>
        <h1 className="text-3xl font-mono font-bold tracking-tight text-foreground sm:text-4xl">Automated Run Selection</h1>
        <p className="text-sm text-muted-foreground sm:text-base">Choose a successfully processed job to deploy to the machine.</p>
      </div>

      <div className="rounded-sm border border-border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-12 text-muted-foreground" role="status" aria-live="polite" data-testid="loading-jobs">
            <Loader2 className="w-8 h-8 animate-spin mb-4 text-primary" />
            <span className="font-mono text-sm">Loading available jobs...</span>
          </div>
        ) : successfulJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-10 text-center sm:p-16" role="status" data-testid="empty-jobs">
            <FileCheck2 className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-mono font-medium mb-2">No Deployable Jobs</h3>
            <p className="text-sm font-mono text-muted-foreground max-w-md">
              There are no successfully processed jobs ready for automated execution. Generate a job in the workspace first.
            </p>
            <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "mt-6")} data-testid="link-to-workspace">
              Go to Workspace
            </Link>
          </div>
        ) : (
          <Table data-testid="table-jobs">
            <TableHeader>
              <TableRow className="hover:bg-transparent bg-muted/30">
                <TableHead>Filename</TableHead>
                <TableHead>Generated At</TableHead>
                <TableHead>Segments</TableHead>
                <TableHead>Time Est.</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {successfulJobs.map((job) => {
                const report = job.report as any;
                const h1Count = report?.partition?.head1_segment_count;
                const h2Count = report?.partition?.head2_segment_count;
                const totalTime = report?.schedule?.estimated_total_time_s;

                return (
                  <TableRow key={job.id} data-testid={`row-job-${job.id}`} className="hover:bg-muted/50 transition-colors cursor-pointer">
                    <TableCell className="font-medium">
                      <Link href={`/automated-drawing/${job.id}`} className="block w-full h-full">
                        {job.filename}
                        <div className="text-xs text-muted-foreground font-mono mt-1 opacity-60">ID: {job.id.substring(0, 8)}...</div>
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">
                      {format(new Date(job.createdAt), "MMM d, HH:mm")}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">
                      {h1Count !== undefined && h2Count !== undefined ? (
                        <div className="flex items-center gap-2">
                          <span className="text-chart-1 font-medium">{h1Count}</span>
                          <span className="opacity-50">/</span>
                          <span className="text-chart-2 font-medium">{h2Count}</span>
                        </div>
                      ) : (
                        <span className="opacity-50">-</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {totalTime ? (
                        <span>{totalTime.toFixed(1)}s</span>
                      ) : (
                        <span className="opacity-50">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                       <Link href={`/automated-drawing/${job.id}`} aria-label={`Prepare run for ${job.filename}`} title="Prepare Run" className={cn(buttonVariants({ variant: "default" }), "font-mono shadow-sm group")} data-testid={`link-prepare-run-${job.id}`}>
                        <Play className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />
                        Prepare
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}