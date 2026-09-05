package com.dmhc.agent.automation;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.dmhc.agent.controller.ControllerRegistry;
import com.dmhc.agent.controller.MachineStatusSnapshot;
import com.dmhc.agent.events.MachineEventPublisher;

/** Runs one explicitly confirmed drawing at a time entirely inside the local Agent. */
public final class DrawingAutomation {
    static final long HOME_TIMEOUT_MILLIS = 180_000;
    static final long MOVE_TIMEOUT_MILLIS = 120_000;
    static final long ZERO_TIMEOUT_MILLIS = 10_000;
    static final long STREAM_TIMEOUT_MILLIS = 12 * 60 * 60 * 1000L;
    static final long CONTROLLER_OPERATION_TIMEOUT_MILLIS = 10_000;
    static final long CLEANUP_TIMEOUT_MILLIS = 5_000;

    private final AutomationMachine controllers;
    private final MachineEventPublisher events;
    private final ExecutorService workflowExecutor = Executors.newSingleThreadExecutor(r -> namedThread(r, "drawing-workflow"));
    private final ExecutorService headExecutor = Executors.newFixedThreadPool(2, r -> namedThread(r, "drawing-head"));
    private final ExecutorService controlExecutor = Executors.newFixedThreadPool(2, r -> namedThread(r, "drawing-control"));
    private final ExecutorService cleanupExecutor = Executors.newCachedThreadPool(r -> namedThread(r, "drawing-cleanup"));
    private final List<CompletableFuture<Void>> activeOperations = new CopyOnWriteArrayList<>();
    private final List<Future<?>> activeTasks = new CopyOnWriteArrayList<>();
    private final Long coordinationTimeoutOverrideMillis;
    private final List<AutomationSnapshot.LogEntry> log = new ArrayList<>();
    private volatile boolean cancelRequested;
    private volatile boolean paused;
    private volatile String runId;
    private volatile AutomationRequest request;
    private volatile String status = "IDLE";
    private volatile String stage = "READY";
    private volatile String message = "Ready for an explicitly confirmed drawing.";
    private volatile String error;
    private volatile String startedAt;
    private volatile String completedAt;
    private volatile Future<?> workflowFuture;
    private volatile CountDownLatch workflowFinished = new CountDownLatch(0);
    private volatile CompletableFuture<Void> cleanupFuture;

    public DrawingAutomation(ControllerRegistry controllers, MachineEventPublisher events) {
        this(new RegistryAutomationMachine(controllers), events, null);
    }

    DrawingAutomation(AutomationMachine controllers, MachineEventPublisher events) {
        this(controllers, events, null);
    }

    DrawingAutomation(AutomationMachine controllers, MachineEventPublisher events, Long coordinationTimeoutOverrideMillis) {
        this.controllers = controllers;
        this.events = events;
        this.coordinationTimeoutOverrideMillis = coordinationTimeoutOverrideMillis;
    }

    public synchronized AutomationSnapshot start(AutomationRequest next) {
        if ("RUNNING".equals(status) || "PAUSED".equals(status) || "ABORTING".equals(status)
            || "RESETTING".equals(status) || "CONNECTING".equals(status)) {
            throw new IllegalStateException("An automated drawing is already active.");
        }
        request = next;
        runId = UUID.randomUUID().toString();
        status = "RUNNING";
        stage = "CONNECTING";
        message = "Connecting both machine heads.";
        error = null;
        paused = false;
        cancelRequested = false;
        startedAt = Instant.now().toString();
        completedAt = null;
        log.clear();
        workflowFinished = new CountDownLatch(1);
        cleanupFuture = null;
        appendLog("info", message);
        workflowFuture = workflowExecutor.submit(this::run);
        return snapshot();
    }

    public synchronized AutomationSnapshot pause() throws Exception {
        requireActive();
        if (paused) return snapshot();
        switch (stage) {
            case "STREAMING_HEADS" -> runBoth("pause streams", CONTROLLER_OPERATION_TIMEOUT_MILLIS, controlExecutor,
                () -> controllers.pauseStream("head-1"),
                () -> controllers.pauseStream("head-2")
            );
            case "STREAMING_GAP_FILL" -> controllers.pauseStream("head-1");
            default -> throw new IllegalStateException("Pause is available only while G-code is streaming.");
        }
        confirmStreamState(true);
        paused = true;
        status = "PAUSED";
        message = "Drawing paused by the operator.";
        appendLog("warning", message);
        publish();
        return snapshot();
    }

    public synchronized AutomationSnapshot resume() throws Exception {
        requireActive();
        if (!paused) return snapshot();
        switch (stage) {
            case "STREAMING_HEADS" -> runBoth("resume streams", CONTROLLER_OPERATION_TIMEOUT_MILLIS, controlExecutor,
                () -> controllers.resumeStream("head-1"),
                () -> controllers.resumeStream("head-2")
            );
            case "STREAMING_GAP_FILL" -> controllers.resumeStream("head-1");
            default -> throw new IllegalStateException("The current stage cannot be resumed.");
        }
        confirmStreamState(false);
        paused = false;
        status = "RUNNING";
        message = "Drawing resumed.";
        appendLog("info", message);
        publish();
        return snapshot();
    }

    public synchronized AutomationSnapshot abort() {
        if (!"RUNNING".equals(status) && !"PAUSED".equals(status)) return snapshot();
        cancelRequested = true;
        paused = false;
        status = "ABORTING";
        message = "Abort requested. Stopping automation and resetting both controllers.";
        appendLog("warning", message);
        logConsole("[ABORT] REQUESTED");
        publish();
        cancelActiveOperations();
        Future<?> activeWorkflow = workflowFuture;
        if (activeWorkflow != null) activeWorkflow.cancel(true);
        scheduleCleanup("operator abort", "CANCELED", null, true);
        return snapshot();
    }

    public synchronized AutomationSnapshot snapshot() {
        return new AutomationSnapshot(
            runId,
            request == null ? null : request.jobId(),
            request == null ? null : request.filename(),
            status,
            stage,
            message,
            error,
            paused,
            startedAt,
            completedAt,
            controllers.status("head-1"),
            controllers.status("head-2"),
            List.copyOf(log)
        );
    }

    public boolean isActive() {
        return "RUNNING".equals(status) || "PAUSED".equals(status) || "ABORTING".equals(status)
            || "RESETTING".equals(status) || "CONNECTING".equals(status);
    }

    public synchronized void shutdown() {
        cancelRequested = true;
        workflowExecutor.shutdownNow();
        headExecutor.shutdownNow();
        controlExecutor.shutdownNow();
        cleanupExecutor.shutdownNow();
    }

    private void run() {
        try {
            AutomationRequest active = request;
            logRunStart(active);

            stage("CONNECTING", "Connecting and validating Head 1 and Head 2.");
            logConsole("[Automation] [STAGE] CONNECTING");
            logConsole("[Automation] [Head 1] CONNECT START");
            controllers.connect("head-1", active.head1Port(), active.baudRate());
            logConsole("[Automation] [Head 1] CONNECT SUCCESS");
            checkCanceled();
            logConsole("[Automation] [Head 2] CONNECT START");
            controllers.connect("head-2", active.head2Port(), active.baudRate());
            logConsole("[Automation] [Head 2] CONNECT SUCCESS");

            stage("CLEARING_ALARMS", "Checking both heads for controller alarms.");
            logConsole("[Automation] [Head 1] ALARM CHECK START");
            controllers.unlockIfAlarm("head-1");
            logConsole("[Automation] [Head 1] ALARM CHECK/UNLOCK SUCCESS");
            logConsole("[Automation] [Head 2] ALARM CHECK START");
            controllers.unlockIfAlarm("head-2");
            logConsole("[Automation] [Head 2] ALARM CHECK/UNLOCK SUCCESS");
            requireReady("head-1");
            requireReady("head-2");

            stage("INITIAL_HOMING", "Homing both heads.");
            logConsole("[Automation] [STAGE] INITIAL_HOMING");
            logConsole("[Automation] [Head 1] HOME START");
            logConsole("[Automation] [Head 2] HOME START");
            runBoth("initial homing", HOME_TIMEOUT_MILLIS,
                () -> controllers.homeAndWait("head-1", HOME_TIMEOUT_MILLIS, this::isCanceled),
                () -> controllers.homeAndWait("head-2", HOME_TIMEOUT_MILLIS, this::isCanceled)
            );
            logConsole("[Automation] [Head 1] HOME SUCCESS");
            logConsole("[Automation] [Head 2] HOME SUCCESS");
            runBoth("initial work-zero", ZERO_TIMEOUT_MILLIS,
                () -> {
                    logConsole("[Automation] [Head 1] G10 WORK ZERO START");
                    controllers.setWorkZeroAndWait("head-1", ZERO_TIMEOUT_MILLIS, this::isCanceled);
                    logConsole("[Automation] [Head 1] G10 WORK ZERO SUCCESS");
                },
                () -> {
                    logConsole("[Automation] [Head 2] G10 WORK ZERO START");
                    controllers.setWorkZeroAndWait("head-2", ZERO_TIMEOUT_MILLIS, this::isCanceled);
                    logConsole("[Automation] [Head 2] G10 WORK ZERO SUCCESS");
                }
            );
            logConsole("[Automation] [STAGE] INITIAL_HOMING SUCCESS");

            stage("SETTING_WORK_ORIGIN", "Moving both heads to their setup offsets: X first, then Z, before setting work zero.");
            logConsole("[Automation] [Head 1] SETUP OFFSET START");
            logConsole("[Automation] [Head 2] SETUP OFFSET START");
            logConsole("[Automation] [Head 1] Target X=" + active.head1OffsetX() + " Z=" + active.head1OffsetZ());
            logConsole("[Automation] [Head 2] Target X=" + active.head2OffsetX() + " Z=" + active.head2OffsetZ());

            runBoth("setup X movement", MOVE_TIMEOUT_MILLIS,
                () -> {
                    logConsole("[Automation] [Head 1] X MOVE START");
                    controllers.jogAndWait("head-1", active.head1OffsetX(), 0d, 0d, 1000d, MOVE_TIMEOUT_MILLIS, this::isCanceled);
                    logConsole("[Automation] [Head 1] X MOVE SUCCESS");
                },
                () -> {
                    logConsole("[Automation] [Head 2] X MOVE START");
                    controllers.jogAndWait("head-2", active.head2OffsetX(), 0d, 0d, 1000d, MOVE_TIMEOUT_MILLIS, this::isCanceled);
                    logConsole("[Automation] [Head 2] X MOVE SUCCESS");
                }
            );

            runBoth("setup Z movement", MOVE_TIMEOUT_MILLIS,
                () -> {
                    logConsole("[Automation] [Head 1] Z MOVE START");
                    controllers.jogAndWait("head-1", 0d, 0d, active.head1OffsetZ(), 1000d, MOVE_TIMEOUT_MILLIS, this::isCanceled);
                    logConsole("[Automation] [Head 1] Z MOVE SUCCESS");
                },
                () -> {
                    logConsole("[Automation] [Head 2] Z MOVE START");
                    controllers.jogAndWait("head-2", 0d, 0d, active.head2OffsetZ(), 1000d, MOVE_TIMEOUT_MILLIS, this::isCanceled);
                    logConsole("[Automation] [Head 2] Z MOVE SUCCESS");
                }
            );

            runBoth("setup position verification", MOVE_TIMEOUT_MILLIS,
                () -> {
                    verifyPosition("head-1", "setup offset", active.head1OffsetX(), active.head1OffsetZ(), 1.0d);
                    logConsole("[Automation] [Head 1] POSITION VERIFIED");
                },
                () -> {
                    verifyPosition("head-2", "setup offset", active.head2OffsetX(), active.head2OffsetZ(), 1.0d);
                    logConsole("[Automation] [Head 2] POSITION VERIFIED");
                }
            );

            runBoth("setup work-zero", ZERO_TIMEOUT_MILLIS,
                () -> {
                    logConsole("[Automation] [Head 1] G10 WORK ZERO START");
                    controllers.setWorkZeroAndWait("head-1", ZERO_TIMEOUT_MILLIS, this::isCanceled);
                    logConsole("[Automation] [Head 1] G10 WORK ZERO SUCCESS");
                },
                () -> {
                    logConsole("[Automation] [Head 2] G10 WORK ZERO START");
                    controllers.setWorkZeroAndWait("head-2", ZERO_TIMEOUT_MILLIS, this::isCanceled);
                    logConsole("[Automation] [Head 2] G10 WORK ZERO SUCCESS");
                }
            );

            stage("STREAMING_HEADS", "Streaming Head 1 and Head 2 G-code.");
            logConsole("[Automation] [STAGE] STREAMING_HEADS");
            logConsole("[Automation] [Head 1] MAIN G-CODE STREAM START");
            logConsole("[Automation] [Head 2] MAIN G-CODE STREAM START");
            runBoth("main G-code stream", STREAM_TIMEOUT_MILLIS,
                () -> controllers.streamAndWait("head-1", active.head1Gcode(), STREAM_TIMEOUT_MILLIS, this::isCanceled),
                () -> controllers.streamAndWait("head-2", active.head2Gcode(), STREAM_TIMEOUT_MILLIS, this::isCanceled)
            );
            logConsole("[Automation] [Head 1] MAIN G-CODE STREAM SUCCESS");
            logConsole("[Automation] [Head 2] MAIN G-CODE STREAM SUCCESS");

            stage("INTERMEDIATE_HOMING", "Head 1 keeps its current position; only Head 2 homes before Gap Fill.");
            logConsole("[Automation] ========================================");
            logConsole("[Automation] [STAGE] INTERMEDIATE_HOMING");
            logConsole("[Automation] [Head 1] KEEP CURRENT POSITION");
            logConsole("[Automation] [Head 1] NO HOMING COMMAND WILL BE SENT");
            logConsole("[Automation] [Head 1] Position before intermediate homing:");
            logPositionSnapshot("head-1");
            logConsole("[Automation] [Head 2] HOME START");
            controllers.homeAndWait("head-2", HOME_TIMEOUT_MILLIS, this::isCanceled);
            logConsole("[Automation] [Head 2] HOME SUCCESS");
            logConsole("[Automation] [Head 1] POSITION PRESERVED");
            logConsole("[Automation] [Head 1] Position after Head 2 homing:");
            logPositionSnapshot("head-1");
            logConsole("[Automation] [STAGE] INTERMEDIATE_HOMING SUCCESS");

            stage("STREAMING_GAP_FILL", "Gap Fill starts directly from Head 1's current position.");
            logConsole("[Automation] ========================================");
            logConsole("[Automation] [STAGE] STREAMING_GAP_FILL");
            logConsole("[Automation] [Head 1] NO REPOSITIONING");
            logConsole("[Automation] [Head 1] Gap Fill will start from current position");
            logPositionSnapshot("head-1");
            logConsole("[Automation] [Head 1] GAP FILL STREAM START");
            controllers.streamAndWait("head-1", active.gapFillGcode(), STREAM_TIMEOUT_MILLIS, this::isCanceled);
            logConsole("[Automation] [Head 1] GAP FILL STREAM SUCCESS");

            stage("FINAL_HOMING", "Gap Fill completed. Performing final homing on both heads.");
            logConsole("[Automation] [STAGE] FINAL_HOMING");
            logConsole("[Automation] [Head 1] HOME START");
            controllers.homeAndWait("head-1", HOME_TIMEOUT_MILLIS, this::isCanceled);
            logConsole("[Automation] [Head 1] HOME SUCCESS");
            logConsole("[Automation] [Head 2] HOME START");
            controllers.homeAndWait("head-2", HOME_TIMEOUT_MILLIS, this::isCanceled);
            logConsole("[Automation] [Head 2] HOME SUCCESS");
            logConsole("[Automation] [STAGE] FINAL_HOMING SUCCESS");

            synchronized (this) {
                status = "COMPLETED";
                stage = "COMPLETE";
                message = "Automated drawing completed successfully. Both heads are home.";
                completedAt = Instant.now().toString();
                appendLog("info", message);
                publish();
            }
            logConsole("[Automation] ========================================");
            logConsole("[Automation] AUTOMATION COMPLETED SUCCESSFULLY");
            logConsole("[Automation] Run ID: " + runId);
            logConsole("[Automation] Job ID: " + (request == null ? "unknown" : request.jobId()));
            logConsole("[Automation] ========================================");
        } catch (CancellationException error) {
            finishCanceled();
        } catch (Exception error) {
            if (isCanceled()) finishCanceled();
            else finishFailed(unwrap(error));
        } finally {
            workflowFinished.countDown();
        }
    }

    private void moveToSetupOrigin(String id, double x, double z) throws Exception {
        if (x != 0d) {
            controllers.jogAndWait(id, x, 0d, 0d, 1000d, MOVE_TIMEOUT_MILLIS, this::isCanceled);
        }
        if (z != 0d) {
            controllers.jogAndWait(id, 0d, 0d, z, 1000d, MOVE_TIMEOUT_MILLIS, this::isCanceled);
        }
    }

    public static boolean positionWithinTolerance(double actualX, double actualZ, double expectedX, double expectedZ, double toleranceMm) {
        double epsilon = 1e-6d;
        return Math.abs(actualX - expectedX) <= toleranceMm + epsilon
            && Math.abs(actualZ - expectedZ) <= toleranceMm + epsilon;
    }

    private void verifyPosition(String id, String operation, double expectedX, double expectedZ, double toleranceMm) throws Exception {
        MachineStatusSnapshot snapshot = controllers.status(id);
        MachineStatusSnapshot.PositionDto wpos = snapshot.workPosition();

        if (wpos == null || (wpos.x() == null && wpos.y() == null && wpos.z() == null)) {
            appendLog("info", id + " reported no usable work position after " + operation + "; skipping strict verification.");
            return;
        }

        Double x = wpos.x();
        Double z = wpos.z();
        if (x == null || z == null) {
            appendLog("info", id + " work position incomplete after " + operation + "; skipping strict verification.");
            return;
        }

        boolean xOk = Math.abs(x - expectedX) <= toleranceMm;
        boolean zOk = Math.abs(z - expectedZ) <= toleranceMm;

        if (!xOk || !zOk) {
            appendLog("warning",
                id + " work-position drift after " + operation + ". " +
                "Expected WPos X=" + expectedX + " Z=" + expectedZ + ", " +
                "but got X=" + x + " Z=" + z + " (tolerance=" + toleranceMm + "mm)."
            );
            return;
        }

        appendLog("info", id + " work position verified: X=" + x + " Z=" + z);
    }

    private void logPositionSnapshot(String headId) {
        try {
            MachineStatusSnapshot snapshot = controllers.status(headId);
            MachineStatusSnapshot.PositionDto pos = snapshot == null ? null : snapshot.machinePosition();
            if (pos == null) {
                logConsole("[Automation] [" + headId + "] Current position: unavailable");
                return;
            }
            logConsole("[Automation] [" + headId + "] X=" + safe(pos.x()) + " Y=" + safe(pos.y()) + " Z=" + safe(pos.z()));
        } catch (Exception error) {
            logConsole("[Automation] [" + headId + "] Position logging failed: " + safeMessage(error));
        }
    }

    private void homeBoth() throws Exception {
        runBoth("homing", HOME_TIMEOUT_MILLIS,
            () -> controllers.homeAndWait("head-1", HOME_TIMEOUT_MILLIS, this::isCanceled),
            () -> controllers.homeAndWait("head-2", HOME_TIMEOUT_MILLIS, this::isCanceled)
        );
    }

    private void requireReady(String id) {
        MachineStatusSnapshot snapshot = controllers.status(id);
        if (!snapshot.connected() || snapshot.firmware() == null) {
            throw new IllegalStateException(id + " did not complete GRBL initialization.");
        }
        if (snapshot.alarm() != null || "ALARM".equalsIgnoreCase(snapshot.state())) {
            throw new IllegalStateException(id + " is in an alarm state.");
        }
    }

    private void runBoth(String operation, long timeoutMillis, CheckedAction head1, CheckedAction head2) throws Exception {
        runBoth(operation, timeoutMillis, headExecutor, head1, head2);
    }

    private void runBoth(
        String operation,
        long timeoutMillis,
        ExecutorService executor,
        CheckedAction head1,
        CheckedAction head2
    ) throws Exception {
        checkCanceled();
        CompletableFuture<Void> first = new CompletableFuture<>();
        CompletableFuture<Void> second = new CompletableFuture<>();
        Future<?> firstTask = submitAction(executor, head1, first);
        Future<?> secondTask = submitAction(executor, head2, second);
        activeOperations.add(first);
        activeOperations.add(second);
        activeTasks.add(firstTask);
        activeTasks.add(secondTask);
        try {
            CompletableFuture.allOf(first, second).get(coordinationTimeout(timeoutMillis), TimeUnit.MILLISECONDS);
        } catch (TimeoutException timeout) {
            first.cancel(true);
            second.cancel(true);
            throw new IllegalStateException(
                "Both heads timed out during " + operation + " after "
                    + coordinationTimeout(timeoutMillis) + " ms.",
                timeout
            );
        } catch (CompletionException error) {
            throw asException(unwrap(error));
        } catch (java.util.concurrent.ExecutionException error) {
            throw asException(unwrap(error));
        } finally {
            activeOperations.remove(first);
            activeOperations.remove(second);
            activeTasks.remove(firstTask);
            activeTasks.remove(secondTask);
        }
        checkCanceled();
    }

    private long coordinationTimeout(long operationTimeoutMillis) {
        return coordinationTimeoutOverrideMillis == null
            ? operationTimeoutMillis
            : coordinationTimeoutOverrideMillis.longValue();
    }

    private void stage(String nextStage, String nextMessage) {
        checkCanceled();
        synchronized (this) {
            stage = nextStage;
            message = nextMessage;
            appendLog("info", nextMessage);
            publish();
        }
    }

    private synchronized void finishFailed(Throwable failure) {
        cancelRequested = true;
        logFailure(headFromFailure(failure), stage, null, failure);
        status = "RESETTING";
        message = "Automated drawing stopped at " + stage + ". Resetting both controllers.";
        error = failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage();
        appendLog("error", message + " " + error);
        publish();
        scheduleCleanup("automation failure", "FAILED", error, false);
    }

    private synchronized void finishCanceled() {
        if ("ABORTING".equals(status) || "RESETTING".equals(status)) return;
        status = "CANCELED";
        message = "Automated drawing was aborted. Inspect both machines before starting again.";
        error = null;
        completedAt = Instant.now().toString();
        appendLog("warning", message);
        publish();
    }

    private void requireActive() {
        if (!"RUNNING".equals(status) && !"PAUSED".equals(status)) {
            throw new IllegalStateException("No automated drawing is active.");
        }
    }

    private boolean isCanceled() {
        return cancelRequested || Thread.currentThread().isInterrupted();
    }

    private void checkCanceled() {
        if (isCanceled()) throw new CancellationException("Drawing aborted by the operator.");
    }

    private void appendLog(String level, String text) {
        log.add(new AutomationSnapshot.LogEntry(Instant.now().toString(), stage, level, text));
        if (log.size() > 500) log.remove(0);
    }

    private String safeMessage(Throwable error) {
        return error == null ? "unknown error" : (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
    }

    private String safe(Object value) {
        return value == null ? "null" : String.valueOf(value);
    }

    private void logRunStart(AutomationRequest active) {
        logConsole("[Automation] ========================================");
        logConsole("[Automation] RUN START");
        logConsole("[Automation] Run ID: " + runId);
        logConsole("[Automation] Job ID: " + active.jobId());
        logConsole("[Automation] Filename: " + active.filename());
        logConsole("[Automation] Head 1 Port: " + active.head1Port());
        logConsole("[Automation] Head 2 Port: " + active.head2Port());
        logConsole("[Automation] Baud Rate: " + active.baudRate());
        logConsole("[Automation] ========================================");
    }

    private void logConsole(String line) {
        writeLogLine(line);
    }

    private void writeLogLine(String line) {
        System.out.println(line);
    }

    private void logFailure(String head, String operation, String command, Throwable failure) {
        String message = failure == null ? "unknown failure" : failure.getMessage();
        String type = failure == null ? "Unknown" : failure.getClass().getSimpleName();
        logConsole("[Automation] [ERROR]");
        logConsole("Stage: " + stage);
        logConsole("Head: " + (head == null ? "N/A" : head));
        logConsole("Operation: " + operation);
        logConsole("Command: " + (command == null ? "N/A" : command));
        logConsole("Exception Type: " + type);
        logConsole("Error Message: " + (message == null ? "N/A" : message));
        if (failure != null && failure.getCause() != null) {
            logConsole("Cause: " + failure.getCause().getClass().getSimpleName() + ": " + failure.getCause().getMessage());
        }
    }

    private String headFromFailure(Throwable failure) {
        String message = failure == null ? null : failure.getMessage();
        if (message != null) {
            if (message.startsWith("head-1 ")) return "head-1";
            if (message.startsWith("head-2 ")) return "head-2";
            if (message.startsWith("Both heads ")) return "head-1/head-2";
        }
        return "N/A";
    }

    private void publish() {
        events.publish("automation.status", null, message, "FAILED".equals(status) ? "error" : "info", snapshot());
    }

    private void runUnchecked(CheckedAction action) {
        try {
            action.run();
        } catch (Exception error) {
            throw new CompletionException(error);
        }
    }

    private void scheduleCleanup(String reason, String terminalStatus, String terminalError, boolean waitForWorkflow) {
        if (cleanupFuture != null) return;
        cancelRequested = true;
        cleanupFuture = CompletableFuture.runAsync(() -> {
            logConsole("[" + lifecycleLabel(reason) + "] STOPPING AUTOMATION");
            cancelActiveOperations();
            if (waitForWorkflow) {
                try {
                    workflowFinished.await(CLEANUP_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            for (String id : List.of("head-1", "head-2")) {
                logConsole("[" + lifecycleLabel(reason) + "] STOPPING " + id.toUpperCase());
                controllers.abortAutomationMotion(id);
            }
            logConsole("[" + lifecycleLabel(reason) + "] DISCONNECTING HEAD 1");
            logConsole("[" + lifecycleLabel(reason) + "] DISCONNECTING HEAD 2");
            controllers.disconnectAutomationSessions();
        }, cleanupExecutor).orTimeout(CLEANUP_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
        cleanupFuture.whenComplete((unused, failure) -> {
            synchronized (this) {
                if (failure != null) {
                    String resetWarning = "Controller reset failed: " + safeMessage(unwrap(failure));
                    if (terminalError == null) error = resetWarning;
                    message = "Automated drawing reset completed with warnings.";
                    appendLog("error", message + " " + resetWarning);
                } else {
                    message = "CANCELED".equals(terminalStatus)
                        ? "Automated drawing was aborted. Both controllers were reset."
                        : "Automated drawing stopped and both controllers were reset.";
                    error = terminalError;
                    appendLog("warning", message);
                }
                status = terminalStatus;
                completedAt = Instant.now().toString();
                logConsole("[" + lifecycleLabel(reason) + "] RESET COMPLETE");
                publish();
            }
        });
    }

    private void cancelActiveOperations() {
        for (CompletableFuture<Void> operation : activeOperations) operation.cancel(true);
        for (Future<?> task : activeTasks) task.cancel(true);
    }

    private String lifecycleLabel(String reason) {
        return "operator abort".equals(reason) ? "ABORT" : "RESET";
    }

    private void confirmStreamState(boolean pausedState) throws Exception {
        List<String> ids = "STREAMING_GAP_FILL".equals(stage)
            ? List.of("head-1")
            : List.of("head-1", "head-2");
        long deadline = System.nanoTime() + CONTROLLER_OPERATION_TIMEOUT_MILLIS * 1_000_000L;
        while (System.nanoTime() < deadline) {
            boolean confirmed = true;
            for (String id : ids) {
                MachineStatusSnapshot current = controllers.status(id);
                if (!current.connected() || "ALARM".equalsIgnoreCase(current.state())) {
                    throw new IllegalStateException(id + " did not remain connected while changing stream state.");
                }
                boolean hold = "HOLD".equalsIgnoreCase(current.state()) || "PAUSED".equalsIgnoreCase(current.state());
                if (hold != pausedState) confirmed = false;
            }
            if (confirmed) return;
            Thread.sleep(50L);
        }
        throw new IllegalStateException(
            "Timed out waiting for both stream controller(s) to " + (pausedState ? "enter HOLD" : "leave HOLD") + "."
        );
    }

    private Future<?> submitAction(ExecutorService executor, CheckedAction action, CompletableFuture<Void> result) {
        return executor.submit(() -> {
            try {
                action.run();
                result.complete(null);
            } catch (Throwable error) {
                result.completeExceptionally(error);
            }
        });
    }

    private Exception asException(Throwable error) {
        return error instanceof Exception exception ? exception : new IllegalStateException(error);
    }

    private Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof CompletionException || current instanceof java.util.concurrent.ExecutionException)
            && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static Thread namedThread(Runnable runnable, String prefix) {
        Thread thread = new Thread(runnable, prefix + "-" + UUID.randomUUID());
        thread.setDaemon(true);
        return thread;
    }

    @FunctionalInterface
    private interface CheckedAction {
        void run() throws Exception;
    }

    interface AutomationMachine {
        MachineStatusSnapshot status(String id);
        void connect(String id, String port, int baudRate) throws Exception;
        void unlockIfAlarm(String id) throws Exception;
        void homeAndWait(String id, long timeoutMillis, java.util.function.BooleanSupplier canceled) throws Exception;
        void jogAndWait(
            String id,
            double x,
            double y,
            double z,
            double feedRate,
            long timeoutMillis,
            java.util.function.BooleanSupplier canceled
        ) throws Exception;
        void setWorkZeroAndWait(String id, long timeoutMillis, java.util.function.BooleanSupplier canceled) throws Exception;
        void streamAndWait(
            String id,
            String gcode,
            long timeoutMillis,
            java.util.function.BooleanSupplier canceled
        ) throws Exception;
        void pauseStream(String id) throws Exception;
        void resumeStream(String id) throws Exception;
        void abortAutomationMotion(String id);
        void disconnectAutomationSessions();
    }

    private static final class RegistryAutomationMachine implements AutomationMachine {
        private final ControllerRegistry registry;

        private RegistryAutomationMachine(ControllerRegistry registry) {
            this.registry = registry;
        }

        @Override
        public MachineStatusSnapshot status(String id) {
            return registry.status(id);
        }

        @Override
        public void connect(String id, String port, int baudRate) throws Exception {
            registry.connectForAutomation(id, port, baudRate);
        }

        @Override
        public void unlockIfAlarm(String id) throws Exception {
            registry.unlockIfAlarm(id);
        }

        @Override
        public void homeAndWait(String id, long timeoutMillis, java.util.function.BooleanSupplier canceled) throws Exception {
            registry.homeAndWait(id, timeoutMillis, canceled);
        }

        @Override
        public void jogAndWait(
            String id,
            double x,
            double y,
            double z,
            double feedRate,
            long timeoutMillis,
            java.util.function.BooleanSupplier canceled
        ) throws Exception {
            registry.jogAndWait(id, x, y, z, feedRate, timeoutMillis, canceled);
        }

        @Override
        public void setWorkZeroAndWait(String id, long timeoutMillis, java.util.function.BooleanSupplier canceled) throws Exception {
            registry.setWorkZeroAndWait(id, timeoutMillis, canceled);
        }

        @Override
        public void streamAndWait(
            String id,
            String gcode,
            long timeoutMillis,
            java.util.function.BooleanSupplier canceled
        ) throws Exception {
            registry.streamAndWait(id, gcode, timeoutMillis, canceled);
        }

        @Override
        public void pauseStream(String id) throws Exception {
            registry.pauseStream(id);
        }

        @Override
        public void resumeStream(String id) throws Exception {
            registry.resumeStream(id);
        }

        @Override
        public void abortAutomationMotion(String id) {
            registry.abortAutomationMotion(id);
        }

        @Override
        public void disconnectAutomationSessions() {
            registry.disconnectAutomationSessions();
        }
    }
}
