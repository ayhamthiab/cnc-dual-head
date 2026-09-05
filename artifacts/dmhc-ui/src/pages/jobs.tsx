import { useListJobs } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { format } from "date-fns";
import { Download, Eye, Loader2, FolderOpen, Play } from "lucide-react";
import { cn } from "@/lib/utils";

type JobList = NonNullable<ReturnType<typeof useListJobs>["data"]>;
type Job = JobList extends readonly (infer T)[] ? T : never;

export default function Jobs() {
  const { data: jobs, isLoading } = useListJobs();

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "success": return <Badge variant="default" className="bg-chart-3 text-chart-3-foreground hover:bg-chart-3/90" data-testid={`badge-status-${status}`}>Success</Badge>;
      case "failed": return <Badge variant="destructive" data-testid={`badge-status-${status}`}>Failed</Badge>;
      case "running": return <Badge variant="secondary" className="animate-pulse" data-testid={`badge-status-${status}`}>Running</Badge>;
      case "pending": return <Badge variant="outline" data-testid={`badge-status-${status}`}>Pending</Badge>;
      default: return <Badge variant="outline" data-testid={`badge-status-${status}`}>{status}</Badge>;
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:space-y-8 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">Output archive</p>
        <h1 className="text-3xl font-mono font-bold tracking-tight text-foreground sm:text-4xl">Job History</h1>
        <p className="text-sm text-muted-foreground sm:text-base">Past compilation jobs and artifacts.</p>
      </div>

      <div className="rounded-sm border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-12 text-muted-foreground" role="status" aria-live="polite" data-testid="loading-jobs">
            <Loader2 className="w-8 h-8 animate-spin mb-4 text-primary" />
            <span className="font-mono text-sm">Loading jobs...</span>
          </div>
        ) : !jobs || jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-10 text-center sm:p-16" role="status" data-testid="empty-jobs">
            <FolderOpen className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-mono font-medium mb-2">No jobs yet</h3>
            <p className="text-sm font-mono text-muted-foreground max-w-md">
              There are no processed jobs in the history. Upload a G-code file in the workspace to start your first compilation.
            </p>
            <Link href="/" className={cn(buttonVariants(), "mt-6")} data-testid="link-to-workspace">
              Go to Workspace
            </Link>
          </div>
        ) : (
          <Table data-testid="table-jobs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Filename</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Segments (H1/H2)</TableHead>
                <TableHead>Speedup</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => {
                // Determine report structure safely
                const report = job.report as any;
                const h1Count = report?.partition?.head1_segment_count;
                const h2Count = report?.partition?.head2_segment_count;
                const speedup = report?.schedule?.speedup_factor;

                return (
                  <TableRow key={job.id} data-testid={`row-job-${job.id}`}>
                    <TableCell className="font-medium">
                      {job.filename}
                      <div className="text-xs text-muted-foreground font-mono mt-1 opacity-50">{job.id.substring(0, 8)}...</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">
                      {format(new Date(job.createdAt), "MMM d, HH:mm")}
                    </TableCell>
                    <TableCell>{getStatusBadge(job.status)}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">
                      {h1Count !== undefined && h2Count !== undefined ? (
                        <span>{h1Count} / {h2Count}</span>
                      ) : (
                        <span className="opacity-50">-</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {speedup ? (
                        <span className="text-primary font-bold">{speedup.toFixed(2)}x</span>
                      ) : (
                        <span className="opacity-50">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {job.status === "success" && (
                          <>
                             <Link href={`/automated-drawing/${job.id}`} aria-label={`Automated run for ${job.filename}`} title="Automated Run" className={cn(buttonVariants({ variant: "default", size: "icon" }), "h-8 w-8")} data-testid={`link-auto-run-${job.id}`}>
                              <Play className="w-4 h-4" />
                            </Link>
                             <a href={`/api/jobs/${job.id}/download/head1`} download title="Download Head 1" aria-label={`Download Head 1 for ${job.filename}`} data-testid={`link-download-head1-${job.id}`}>
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-chart-1 hover:text-chart-1 hover:bg-chart-1/10">
                                <Download className="w-4 h-4" />
                              </Button>
                            </a>
                             <a href={`/api/jobs/${job.id}/download/head2`} download title="Download Head 2" aria-label={`Download Head 2 for ${job.filename}`} data-testid={`link-download-head2-${job.id}`}>
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-chart-2 hover:text-chart-2 hover:bg-chart-2/10">
                                <Download className="w-4 h-4" />
                              </Button>
                            </a>
                          </>
                        )}
                         <Link href={`/viz/${job.id}`} aria-label={`View ${job.filename}`} title="View job" className={cn(buttonVariants({ variant: "secondary", size: "icon" }), "h-8 w-8 ml-2")} data-testid={`link-view-${job.id}`}>
                          <Eye className="w-4 h-4" />
                        </Link>
                      </div>
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
