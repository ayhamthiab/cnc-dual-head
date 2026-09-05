package com.dmhc.agent.automation;

import com.dmhc.agent.controller.MachineStatusSnapshot;
import java.util.List;

public record AutomationSnapshot(
    String runId,
    String jobId,
    String filename,
    String status,
    String stage,
    String message,
    String error,
    boolean paused,
    String startedAt,
    String completedAt,
    MachineStatusSnapshot head1,
    MachineStatusSnapshot head2,
    List<LogEntry> log
) {
    public record LogEntry(String timestamp, String stage, String level, String message) {}
}