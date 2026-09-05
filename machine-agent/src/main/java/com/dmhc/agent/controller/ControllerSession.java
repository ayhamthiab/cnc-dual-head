package com.dmhc.agent.controller;

import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

import com.dmhc.agent.events.MachineEventPublisher;
import com.willwinder.universalgcodesender.GrblController;
import com.willwinder.universalgcodesender.connection.ConnectionDriver;
import com.willwinder.universalgcodesender.firmware.FirmwareSetting;
import com.willwinder.universalgcodesender.firmware.grbl.GrblCapabilitiesConstants;
import com.willwinder.universalgcodesender.firmware.grbl.commands.GetSettingsCommand;
import com.willwinder.universalgcodesender.listeners.ControllerStatus;
import com.willwinder.universalgcodesender.listeners.DefaultControllerListener;
import com.willwinder.universalgcodesender.listeners.MessageType;
import com.willwinder.universalgcodesender.model.Alarm;
import com.willwinder.universalgcodesender.model.Axis;
import com.willwinder.universalgcodesender.model.Position;
import com.willwinder.universalgcodesender.model.UnitUtils;
import com.willwinder.universalgcodesender.services.MessageService;
import com.willwinder.universalgcodesender.types.GcodeCommand;
import com.willwinder.universalgcodesender.utils.ControllerUtils;
import com.willwinder.universalgcodesender.utils.SimpleGcodeStreamReader;

/**
 * One isolated UGS/GRBL controller and one serial port. It never connects or
 * sends movement by itself; callers must invoke an explicit API action.
 */
final class ControllerSession {
    private static final long SERIAL_OPEN_TIMEOUT_MILLIS = 10_000;
    private static final long INITIALIZATION_TIMEOUT_MILLIS = 20_000;
    private static final long INITIALIZATION_POLL_MILLIS = 50;
    private static final long ALARM_CLEAR_TIMEOUT_MILLIS = 5_000;
    private static final long UGS_OPERATION_TIMEOUT_MILLIS = 10_000;
    private static final long STATE_READ_TIMEOUT_MILLIS = 2_000;
    private static final ExecutorService SERIAL_OPERATIONS = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "dmhc-serial-operation");
        thread.setDaemon(true);
        return thread;
    });
    private static final ExecutorService UGS_OPERATIONS = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "dmhc-ugs-operation");
        thread.setDaemon(true);
        return thread;
    });
    private final String id;
    private final int head;
    private final MachineEventPublisher events;
    private final Supplier<GrblController> controllerFactory;
    private final Object stateLock = new Object();
    private volatile GrblController controller;
    private volatile GrblController initializedController;
    private volatile String port;
    private volatile int baudRate;
    private volatile boolean ready;
    private volatile boolean serialDriverStuck;
    private volatile MachineStatusSnapshot snapshot;
    private final AtomicLong homeGeneration = new AtomicLong();
    private final AtomicLong jogGeneration = new AtomicLong();
    private final AtomicLong streamGeneration = new AtomicLong();
    private volatile long pendingHomeGeneration;
    private volatile long activeHomeGeneration;
    private volatile long completedHomeGeneration;
    private volatile long acceptedJogGeneration;
    private volatile long rejectedJogGeneration;
    private volatile long activeStreamGeneration;
    private volatile long completedStreamGeneration;
    private volatile long canceledStreamGeneration;

    ControllerSession(String id, int head, MachineEventPublisher events) {
        this(id, head, events, SessionGrblController::new);
    }

    ControllerSession(String id, int head, MachineEventPublisher events, Supplier<GrblController> controllerFactory) {
        this.id = id;
        this.head = head;
        this.events = events;
        this.controllerFactory = controllerFactory;
        this.snapshot = MachineStatusSnapshot.disconnected(id, head);
    }

    synchronized void connect(String requestedPort, int requestedBaudRate) throws Exception {
        if (isConnected()) throw new IllegalStateException(id + " is already connected.");
        if (serialDriverStuck) {
            throw new IllegalStateException(
                "A previous Windows serial operation became unresponsive for " + id
                    + ". Close any serial monitor and restart the Machine Agent before trying again."
            );
        }
        GrblController next = controllerFactory.get();
        configureListeners(next);
        synchronized (stateLock) {
            this.port = requestedPort;
            this.baudRate = requestedBaudRate;
            this.ready = false;
            this.initializedController = null;
            this.controller = next;
        }
        refresh("Connecting on " + requestedPort + " at " + requestedBaudRate + " baud", "info");
        try {
            // UGS initializes GRBL and starts its status poller. It does not
            // issue home, jog, G0/G1, or stream commands during this call.
            events.publish(
                "controller.connect.opening",
                id,
                "Opening " + requestedPort + " through JSerialComm; waiting for Windows",
                "info",
                snapshot
            );
            openWithTimeout(next, requestedPort, requestedBaudRate);
            events.publish(
                "controller.connect.transport-open",
                id,
                "Serial transport opened; waiting for GRBL firmware identification and status",
                "info",
                snapshot
            );
            waitForInitialization(next, requestedPort);
            synchronized (stateLock) {
                if (controller != next) throw new IllegalStateException(id + " connection was canceled.");
                this.ready = true;
            }
            unlockIfAlarm();
            refresh("Connected to " + requestedPort, "info");
        } catch (Exception error) {
            cleanupAfterFailedConnect(next);
            synchronized (stateLock) {
                if (controller == next) {
                    this.controller = null;
                    this.port = null;
                    this.baudRate = 0;
                    this.ready = false;
                    this.initializedController = null;
                    this.snapshot = MachineStatusSnapshot.disconnected(id, head);
                }
            }
            events.publish("controller.error", id, "Connection failed: " + safeMessage(error), "error", snapshot);
            throw error;
        }
    }

    synchronized void disconnect() {
        GrblController active = controller;
        if (active != null) {
            try {
                active.setStatusUpdatesEnabled(false);
                active.closeCommPort();
            } catch (Exception error) {
                events.publish("controller.error", id, "Disconnect warning: " + safeMessage(error), "warning", snapshot);
            }
        }
        synchronized (stateLock) {
            controller = null;
            port = null;
            baudRate = 0;
            ready = false;
            initializedController = null;
            snapshot = MachineStatusSnapshot.disconnected(id, head);
            invalidateOperationState();
        }
        events.publish("controller.disconnected", id, "Disconnected", "info", snapshot);
    }

    synchronized void shutdownAndReset() {
        GrblController active = controller;
        String previousPort = port;
        synchronized (stateLock) {
            controller = null;
            initializedController = null;
            ready = false;
            port = null;
            baudRate = 0;
            invalidateOperationState();
            snapshot = MachineStatusSnapshot.disconnected(id, head);
        }
        if (active != null) {
            try {
                active.cancelSend();
            } catch (Exception ignored) {
                // The controller may already have stopped after an alarm or reset.
            }
            try {
                active.issueSoftReset();
            } catch (Exception ignored) {
                // Continue to close the transport even when GRBL no longer responds.
            }
            try {
                active.setStatusUpdatesEnabled(false);
                active.closeCommPort();
            } catch (Exception error) {
                events.publish("controller.error", id, "Reset disconnect warning: " + safeMessage(error), "warning", snapshot);
            }
        }
        events.publish(
            "controller.reset.complete",
            id,
            "Controller session reset" + (previousPort == null ? "" : " for " + previousPort),
            "warning",
            snapshot
        );
    }

    synchronized long home() throws Exception {
        return home(UGS_OPERATION_TIMEOUT_MILLIS);
    }

    synchronized long home(long timeoutMillis) throws Exception {
        long generation = homeGeneration.incrementAndGet();
        pendingHomeGeneration = generation;
        try {
            executeWithTimeout(id + " homing initiation", timeoutMillis, () -> {
                requireConnected().performHomingCycle();
                return null;
            });
            activeHomeGeneration = generation;
        } catch (Exception error) {
            pendingHomeGeneration = 0;
            activeHomeGeneration = 0;
            throw error;
        }
        events.publish("controller.home.started", id, "Homing requested by the user", "warning", snapshot());
        return generation;
    }

    synchronized long jog(double x, double y, double z, double feedRate) throws Exception {
        return jog(x, y, z, feedRate, UGS_OPERATION_TIMEOUT_MILLIS);
    }

    synchronized long jog(double x, double y, double z, double feedRate, long timeoutMillis) throws Exception {
        GrblController active = requireConnected();
        long generation = jogGeneration.incrementAndGet();
        boolean hardwareJog = active.getCapabilities().hasCapability(GrblCapabilitiesConstants.HARDWARE_JOGGING);
        String commandText = hardwareJog
            ? GrblCommandBuilder.jog(x, y, z, feedRate)
            : GrblCommandBuilder.legacyJog(x, y, z, feedRate);
        GcodeCommand command = active.createCommand(commandText);
        if (!hardwareJog) command.setTemporaryParserModalChange(true);
        command.addListener(completed -> {
            if (!completed.isDone()) return;
            String response = completed.getResponse();
            if (completed.isOk()) {
                acceptedJogGeneration = generation;
                events.publish(
                    "controller.jog.accepted",
                    id,
                    "GRBL accepted jog: " + commandText,
                    "info",
                    snapshot()
                );
            } else {
                rejectedJogGeneration = generation;
                events.publish(
                    "controller.jog.rejected",
                    id,
                    "GRBL rejected jog " + commandText + (response == null || response.isBlank() ? "" : ": " + response),
                    "error",
                    snapshot()
                );
            }
        });
        executeWithTimeout(id + " jog initiation", timeoutMillis, () -> {
            active.sendCommandImmediately(command);
            if (!hardwareJog) active.restoreParserModalState();
            active.requestStatusReport();
            return null;
        });
        events.publish("controller.jog.queued", id, "Jog queued: " + commandText, "warning", snapshot());
        return generation;
    }

    synchronized void command(String command) throws Exception {
        GrblController active = requireConnected();
        active.sendCommandImmediately(active.createCommand(command));
        events.publish("controller.command.sent", id, "Sent: " + command, "warning", snapshot());
    }

    synchronized void reset() throws Exception {
        requireConnected().issueSoftReset();
        events.publish("controller.reset", id, "Soft reset requested by the user", "warning", snapshot());
    }

    synchronized void unlock() throws Exception {
        requireConnected().killAlarmLock();
        events.publish("controller.unlock", id, "Alarm unlock requested by the user", "warning", snapshot());
    }

    synchronized void unlockIfAlarm() throws Exception {
        MachineStatusSnapshot current = snapshot();
        if (!current.connected() || (!"ALARM".equalsIgnoreCase(current.state()) && current.alarm() == null)) return;

        GrblController active = requireConnected();
        active.killAlarmLock();
        active.requestStatusReport();
        events.publish(
            "controller.unlock.automatic",
            id,
            "GRBL reported Alarm; automatic $X unlock requested",
            "warning",
            snapshot()
        );
        waitForAlarmClear(active);
    }

    synchronized List<FirmwareSetting> settings(boolean refresh) throws Exception {
        GrblController active = requireConnected();
        if (refresh) {
            ControllerUtils.sendAndWaitForCompletion(active, new GetSettingsCommand());
        }
        return active.getFirmwareSettings().getAllSettings().stream()
            .sorted(Comparator.comparing(FirmwareSetting::getKey))
            .toList();
    }

    synchronized FirmwareSetting setSetting(String key, String value) throws Exception {
        if (key == null || !key.matches("\\$[0-9]+|[a-zA-Z0-9_.-]+")) {
            throw new IllegalArgumentException("Invalid GRBL setting key.");
        }

        if (value == null) {
            throw new IllegalArgumentException("Setting value is required.");
        }

        String normalizedValue = value.trim();

        if (normalizedValue.isBlank() || normalizedValue.length() > 64) {
            throw new IllegalArgumentException("Setting value is required and must be at most 64 characters.");
        }

        FirmwareSetting updated = requireConnected().getFirmwareSettings().setValue(key, normalizedValue);
        if (!normalizedValue.equals(updated.getValue())) {
            throw new IllegalStateException("GRBL did not confirm the requested value for " + key + ".");
        }
        events.publish("controller.setting.updated", id, "Updated GRBL setting " + key, "warning", snapshot());
        return updated;
    }

    synchronized void applySettings(java.util.Map<String, String> settings) throws Exception {
        if (settings == null || settings.isEmpty()) {
            throw new IllegalArgumentException("At least one GRBL setting is required.");
        }
        for (var entry : settings.entrySet()) {
            if (entry.getKey() == null || !entry.getKey().matches("\\$[0-9]+|[a-zA-Z0-9_.-]+")) {
                throw new IllegalArgumentException("Invalid GRBL setting key.");
            }
            if (entry.getValue() == null) {
                throw new IllegalArgumentException("GRBL setting values are required and must be at most 64 characters.");
            }

            String value = entry.getValue().trim();
            if (value.isBlank() || value.length() > 64) {
                throw new IllegalArgumentException("GRBL setting values are required and must be at most 64 characters.");
            }
        }
        GrblController active = requireConnected();
        for (var entry : settings.entrySet()) {
            active.getFirmwareSettings().setValue(entry.getKey(), entry.getValue().trim());
        }
        events.publish("controller.settings.updated", id, "Applied " + settings.size() + " GRBL setup setting(s)", "warning", snapshot());
    }

    synchronized void setWorkZero(String axis) throws Exception {
        setWorkZero(axis, UGS_OPERATION_TIMEOUT_MILLIS);
    }

    synchronized void setWorkZero(String axis, long timeoutMillis) throws Exception {
        GrblController active = requireConnected();

        if (axis == null || axis.isBlank()) {
            throw new IllegalArgumentException("Axis must be X, Y, Z, or ALL.");
        }

        String normalizedAxis = axis.trim().toUpperCase();
        String command;

        if ("ALL".equals(normalizedAxis)) {
            command = GrblCommandBuilder.setWorkPosition(0d, 0d, 0d);
        } else {
            try {
                Axis selected = Axis.valueOf(normalizedAxis);
                command = switch (selected) {
                    case X -> GrblCommandBuilder.setWorkPosition(0d, null, null);
                    case Y -> GrblCommandBuilder.setWorkPosition(null, 0d, null);
                    case Z -> GrblCommandBuilder.setWorkPosition(null, null, 0d);
                    default -> throw new IllegalArgumentException("Axis must be X, Y, Z, or ALL.");
                };
            } catch (IllegalArgumentException error) {
                throw new IllegalArgumentException("Axis must be X, Y, Z, or ALL.");
            }
        }

        sendAcceptedCommand(active, command, timeoutMillis);

        events.publish(
            "controller.work-zero",
            id,
            "Work zero applied for " + normalizedAxis,
            "warning",
            snapshot()
        );
    }

    synchronized void setWorkOffset(Double x, Double y, Double z) throws Exception {
        GrblController active = requireConnected();
        String command = GrblCommandBuilder.setWorkPosition(x, y, z);
        sendAcceptedCommand(active, command, UGS_OPERATION_TIMEOUT_MILLIS);
        events.publish("controller.work-offset", id, "Work coordinate offset applied", "warning", snapshot());
    }

    synchronized long startStream(String gcode) throws Exception {
        return startStream(gcode, UGS_OPERATION_TIMEOUT_MILLIS);
    }

    synchronized long startStream(String gcode, long timeoutMillis) throws Exception {
        GrblController active = requireConnected();

        if (gcode == null || gcode.isBlank()) {
            throw new IllegalArgumentException("G-code content is required.");
        }

        if (active.isStreaming()) {
            throw new IllegalStateException("A stream is already active on " + id + ".");
        }

        long generation = streamGeneration.incrementAndGet();
        activeStreamGeneration = generation;
        String[] lines = gcode
            .replace("\r\n", "\n")
            .replace('\r', '\n')
            .split("\n");
        try {
            executeWithTimeout(id + " stream startup", timeoutMillis, () -> {
                active.queueStream(new SimpleGcodeStreamReader(lines));
                active.beginStreaming();
                return null;
            });
        } catch (Exception error) {
            activeStreamGeneration = 0;
            throw error;
        }
        return generation;
    }

    synchronized void pauseStream() throws Exception {
        GrblController active = requireConnected();
        executeWithTimeout(id + " stream pause", UGS_OPERATION_TIMEOUT_MILLIS, () -> {
            active.pauseStreaming();
            return null;
        });
    }

    synchronized void resumeStream() throws Exception {
        GrblController active = requireConnected();
        executeWithTimeout(id + " stream resume", UGS_OPERATION_TIMEOUT_MILLIS, () -> {
            active.resumeStreaming();
            return null;
        });
    }

    synchronized void stopStream() throws Exception {
        requireConnected().cancelSend();
    }

    boolean isConnected() {
        return ready && controller != null && Boolean.TRUE.equals(controller.isCommOpen());
    }

    String port() {
        return port;
    }

    int head() {
        return head;
    }

    int baudRate() {
        return baudRate;
    }

    boolean homeCompleted(long generation) {
        return completedHomeGeneration >= generation && !hasPendingCommandResponses();
    }

    boolean jogAccepted(long generation) {
        return acceptedJogGeneration >= generation;
    }

    boolean jogRejected(long generation) {
        return rejectedJogGeneration >= generation;
    }

    boolean streamCompleted(long generation) {
        return completedStreamGeneration >= generation;
    }

    boolean streamCanceled(long generation) {
        return canceledStreamGeneration >= generation;
    }

    String id() {
        return id;
    }

    MachineStatusSnapshot snapshot() {
        try {
            return snapshot(STATE_READ_TIMEOUT_MILLIS);
        } catch (Exception error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            events.publish(
                "controller.status.timeout",
                id,
                "Controller state read unavailable: " + safeMessage(error),
                "warning",
                snapshot
            );
        }
        return snapshot;
    }

    MachineStatusSnapshot snapshot(long timeoutMillis) throws Exception {
        return executeWithTimeout(id + " state refresh", timeoutMillis, () -> {
            refresh(null, null);
            return snapshot;
        });
    }

    private void sendAcceptedCommand(GrblController active, String commandText, long timeoutMillis) throws Exception {
        var command = executeWithTimeout(
            id + " command acknowledgement",
            timeoutMillis,
            () -> ControllerUtils.sendAndWaitForCompletion(active, active.createCommand(commandText))
        );
        if (!command.isOk()) {
            String response = command.getResponse();
            throw new IllegalStateException(
                "GRBL rejected command " + commandText + (response == null || response.isBlank() ? "." : ": " + response)
            );
        }
        active.requestStatusReport();
    }

    private <T> T executeWithTimeout(String operationName, long timeoutMillis, Callable<T> operation) throws Exception {
        if (timeoutMillis <= 0) throw new OperationTimeoutException(operationName, timeoutMillis);
        Future<T> operationFuture = UGS_OPERATIONS.submit(operation);
        try {
            return operationFuture.get(timeoutMillis, TimeUnit.MILLISECONDS);
        } catch (TimeoutException timeout) {
            operationFuture.cancel(true);
            throw new OperationTimeoutException(operationName, timeoutMillis, timeout);
        } catch (ExecutionException execution) {
            Throwable cause = execution.getCause();
            if (cause instanceof Exception exception) throw exception;
            if (cause instanceof Error error) throw error;
            throw new IllegalStateException(operationName + " failed.", cause);
        } catch (InterruptedException interrupted) {
            operationFuture.cancel(true);
            Thread.currentThread().interrupt();
            throw interrupted;
        }
    }

    private GrblController requireConnected() {
        GrblController active = controller;
        if (!ready || active == null || !Boolean.TRUE.equals(active.isCommOpen())) {
            throw new IllegalStateException(id + " is not connected.");
        }
        return active;
    }

    private void waitForInitialization(GrblController active, String requestedPort) throws Exception {
        long deadline = System.nanoTime() + INITIALIZATION_TIMEOUT_MILLIS * 1_000_000L;
        boolean statusPollingStarted = false;
        while (System.nanoTime() < deadline) {
            if (!Boolean.TRUE.equals(active.isCommOpen())) {
                throw new IllegalStateException(
                    "GRBL initialization failed on " + requestedPort + ". Check this head's console for the controller response."
                );
            }
            if (!statusPollingStarted && initializedController == active) {
                // UGS reports its successful initializer completion while the
                // controller state is still CONNECTING. Enable the poller now
                // so the next status report can resolve that state to IDLE,
                // ALARM, HOLD, etc. Waiting for the state before enabling this
                // poller creates a circular wait.
                active.setStatusUpdateRate(250);
                active.setStatusUpdatesEnabled(true);
                statusPollingStarted = true;
            }
            ControllerStatus status = active.getControllerStatus();
            if (
                initializedController == active
                && status != null
                && status.getState() != null
                && !"UNKNOWN".equalsIgnoreCase(status.getState().name())
                && !"CONNECTING".equalsIgnoreCase(status.getState().name())
            ) return;
            try {
                Thread.sleep(INITIALIZATION_POLL_MILLIS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrupted while waiting for GRBL initialization.", interrupted);
            }
        }
        throw new IllegalStateException(
            "Timed out waiting for GRBL initialization on " + requestedPort + ". Check the selected port, baud rate, and controller firmware."
        );
    }

    private void waitForAlarmClear(GrblController active) throws Exception {
        long deadline = System.nanoTime() + ALARM_CLEAR_TIMEOUT_MILLIS * 1_000_000L;
        while (System.nanoTime() < deadline) {
            if (controller != active || !Boolean.TRUE.equals(active.isCommOpen())) {
                throw new IllegalStateException(id + " disconnected while clearing the GRBL alarm.");
            }
            refresh(active, null, null);
            MachineStatusSnapshot current = snapshot;
            if (
                !"ALARM".equalsIgnoreCase(current.state())
                && current.alarm() == null
                && !hasPendingCommandResponses(active)
            ) return;
            try {
                Thread.sleep(INITIALIZATION_POLL_MILLIS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrupted while waiting for GRBL alarm unlock.", interrupted);
            }
        }
        throw new IllegalStateException(id + " remained in an alarm state after the automatic $X unlock.");
    }

    private boolean hasPendingCommandResponses() {
        GrblController active = controller;
        return active != null && hasPendingCommandResponses(active);
    }

    private boolean hasPendingCommandResponses(GrblController active) {
        return active.getActiveCommand().isPresent()
            || active.getCommunicator().hasCommandsAwaitingResponse();
    }

    private void invalidateOperationState() {
        homeGeneration.incrementAndGet();
        jogGeneration.incrementAndGet();
        streamGeneration.incrementAndGet();
        pendingHomeGeneration = 0;
        activeHomeGeneration = 0;
        completedHomeGeneration = 0;
        acceptedJogGeneration = 0;
        rejectedJogGeneration = 0;
        activeStreamGeneration = 0;
        completedStreamGeneration = 0;
        canceledStreamGeneration = 0;
    }

    private void openWithTimeout(GrblController next, String requestedPort, int requestedBaudRate) throws Exception {
        Future<Boolean> opening = SERIAL_OPERATIONS.submit(
            () -> next.openCommPort(ConnectionDriver.JSERIALCOMM, requestedPort, requestedBaudRate)
        );
        try {
            Boolean opened = opening.get(SERIAL_OPEN_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
            if (!Boolean.TRUE.equals(opened) || !Boolean.TRUE.equals(next.isCommOpen())) {
                throw new IllegalStateException(
                    "Windows could not open " + requestedPort
                        + ". Close UGS, Arduino Serial Monitor, and any other program using this COM port."
                );
            }
        } catch (TimeoutException timeout) {
            serialDriverStuck = true;
            opening.cancel(true);
            boolean transportOpened = Boolean.TRUE.equals(next.isCommOpen());
            throw new IllegalStateException(
                "Timed out opening " + requestedPort + " after "
                    + (SERIAL_OPEN_TIMEOUT_MILLIS / 1000)
                    + " seconds. "
                    + (transportOpened
                        ? "Windows opened the COM handle, but the UGS connection lifecycle did not return."
                        : "Windows did not report an open COM handle.")
                    + " Java " + System.getProperty("java.version")
                    + ", " + System.getProperty("os.name") + " " + System.getProperty("os.arch") + ".",
                timeout
            );
        } catch (ExecutionException execution) {
            Throwable cause = execution.getCause();
            if (cause instanceof Exception exception) throw exception;
            throw new IllegalStateException("Could not open " + requestedPort + ".", cause);
        } catch (InterruptedException interrupted) {
            opening.cancel(true);
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while opening " + requestedPort + ".", interrupted);
        }
    }

    private void cleanupAfterFailedConnect(GrblController failed) {
        SERIAL_OPERATIONS.execute(() -> {
            try {
                failed.setStatusUpdatesEnabled(false);
                if (Boolean.TRUE.equals(failed.isCommOpen())) failed.closeCommPort();
            } catch (Exception closeError) {
                events.publish(
                    "controller.error",
                    id,
                    "Connection cleanup warning: " + safeMessage(closeError),
                    "warning",
                    snapshot
                );
            }
        });
    }

    private void configureListeners(GrblController next) {
        MessageService messages = new MessageService();
        messages.addListener((MessageType type, String message) -> {
            MachineStatusSnapshot current;
            synchronized (stateLock) {
                if (next != controller) return;
                if (message.trim().startsWith("*** Connected to ")) {
                    initializedController = next;
                }
                current = snapshot;
            }
            events.publish("controller.message", id, message.trim(), type.name().toLowerCase(), current);
        });
        next.setMessageService(messages);

        next.addListener(new DefaultControllerListener() {
            @Override
            public void statusStringListener(ControllerStatus status) {
                String state = status == null || status.getState() == null ? "UNKNOWN" : status.getState().name();
                synchronized (stateLock) {
                    if (next != controller) return;
                    long pending = pendingHomeGeneration;
                    if (pending > 0 && !"IDLE".equalsIgnoreCase(state)) {
                        activeHomeGeneration = pending;
                    } else if (
                        pending > 0
                        && activeHomeGeneration == pending
                        && "IDLE".equalsIgnoreCase(state)
                    ) {
                        completedHomeGeneration = pending;
                        pendingHomeGeneration = 0;
                        activeHomeGeneration = 0;
                        events.publish("controller.home.completed", id, "Homing completed", "info", snapshot);
                    }
                }
                refresh(next, "Status: " + state, "info");
            }

            @Override
            public void receivedAlarm(Alarm alarm) {
                refresh(next, "GRBL alarm: " + alarm.name(), "error");
            }

            @Override
            public void streamStarted() {
                refresh(next, "G-code stream started", "warning");
            }

            @Override
            public void streamPaused() {
                refresh(next, "G-code stream paused", "warning");
            }

            @Override
            public void streamResumed() {
                refresh(next, "G-code stream resumed", "warning");
            }

            @Override
            public void streamComplete() {
                synchronized (stateLock) {
                    if (next != controller) return;
                    completedStreamGeneration = activeStreamGeneration;
                    activeStreamGeneration = 0;
                }
                refresh(next, "G-code stream completed", "info");
            }

            @Override
            public void streamCanceled() {
                synchronized (stateLock) {
                    if (next != controller) return;
                    canceledStreamGeneration = activeStreamGeneration;
                    activeStreamGeneration = 0;
                }
                refresh(next, "G-code stream canceled", "warning");
            }
        });
    }

    private void refresh(String eventMessage, String level) {
        refresh(null, eventMessage, level);
    }

    private void refresh(GrblController source, String eventMessage, String level) {
        MachineStatusSnapshot published;
        synchronized (stateLock) {
            if (source != null && source != controller) return;
            GrblController active = controller;
            if (active == null) {
                snapshot = MachineStatusSnapshot.disconnected(id, head);
            } else {
                ControllerStatus status = active.getControllerStatus();
                String state = status == null || status.getState() == null ? "CONNECTING" : status.getState().name();
                String alarm = "ALARM".equals(state) ? state : null;
                Optional<?> current = active.getActiveCommand();
                snapshot = new MachineStatusSnapshot(
                    id,
                    head,
                    ready && Boolean.TRUE.equals(active.isCommOpen()),
                    port,
                    baudRate,
                    active.getCommunicatorState().name(),
                    state,
                    position(status == null ? null : status.getMachineCoord()),
                    position(status == null ? null : status.getWorkCoord()),
                    limitPins(status == null ? null : status.getEnabledPins()),
                    status == null ? null : status.getFeedSpeed(),
                    status == null ? null : status.getSpindleSpeed(),
                    safeFirmware(active),
                    alarm,
                    null,
                    active.rowsSent(),
                    active.rowsCompleted(),
                    active.rowsRemaining(),
                    current.map(Object::toString).orElse(null)
                );
            }
            published = snapshot;
        }
        if (eventMessage != null) {
            events.publish("controller.status", id, eventMessage, level == null ? "info" : level, published);
        }
    }

    private MachineStatusSnapshot.PositionDto position(Position position) {
        if (position == null) return null;
        Position millimeters = position.getPositionIn(UnitUtils.Units.MM);
        return new MachineStatusSnapshot.PositionDto(
            safeAxis(millimeters, Axis.X), safeAxis(millimeters, Axis.Y), safeAxis(millimeters, Axis.Z)
        );
    }

    private MachineStatusSnapshot.LimitPinsDto limitPins(com.willwinder.universalgcodesender.listeners.EnabledPins pins) {
        if (pins == null) return null;
        return new MachineStatusSnapshot.LimitPinsDto(
            pins.x(), null, null,
            pins.y(), null, null,
            pins.z(), null, null
        );
    }

    private Double safeAxis(Position position, Axis axis) {
        double value = position.get(axis);
        return Double.isNaN(value) || Double.isInfinite(value) ? null : value;
    }

    private String safeFirmware(GrblController active) {
        try {
            String firmware = active.getFirmwareVersion();
            return firmware == null || firmware.startsWith("<") || "GRBL".equalsIgnoreCase(firmware.trim())
                ? null
                : firmware;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private String safeMessage(Exception error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    static final class OperationTimeoutException extends Exception {
        OperationTimeoutException(String operationName, long timeoutMillis) {
            this(operationName, timeoutMillis, null);
        }

        OperationTimeoutException(String operationName, long timeoutMillis, Throwable cause) {
            super("UGS operation timed out after " + timeoutMillis + " ms: " + operationName, cause);
        }
    }
}
