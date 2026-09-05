package com.dmhc.agent.controller;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;

import com.dmhc.agent.events.MachineEventPublisher;
import com.willwinder.universalgcodesender.connection.ConnectionDriver;
import com.willwinder.universalgcodesender.connection.ConnectionFactory;
import com.willwinder.universalgcodesender.connection.IConnectionDevice;
import com.willwinder.universalgcodesender.firmware.FirmwareSetting;

/** Owns exactly two intentionally isolated GRBL sessions: head-1 and head-2. */
public final class ControllerRegistry {
    private static final int DISCONNECT_CONFIRM_STRIKES = 4;

    private final MachineEventPublisher events;
    private final PortLeaseBook portLeases = new PortLeaseBook();
    private final ConcurrentHashMap<String, Integer> disconnectStrikes = new ConcurrentHashMap<>();
    private final ControllerSession head1;
    private final ControllerSession head2;

    public ControllerRegistry(MachineEventPublisher events) {
        this.events = events;
        this.head1 = new ControllerSession("head-1", 1, events);
        this.head2 = new ControllerSession("head-2", 2, events);
    }

    public Collection<ControllerSession> sessions() {
        return List.of(head1, head2);
    }

    public ControllerSession require(String candidate) {
        String id = normalizeId(candidate);
        return switch (id) {
            case "head-1" -> head1;
            case "head-2" -> head2;
            default -> throw new IllegalArgumentException("Unknown controller. Use head-1 or head-2.");
        };
    }

    public MachineStatusSnapshot connect(String id, String port, int baudRate) throws Exception {
        validateBaudRate(baudRate);
        if (port == null || port.isBlank()) throw new IllegalArgumentException("A serial port is required.");
        ControllerSession session = require(id);
        synchronized (session) {
            if (session.isConnected()) throw new IllegalStateException(session.id() + " is already connected.");
            validateExistingPort(port);
            portLeases.acquire(session.id(), port);
            try {
                session.connect(port.trim(), baudRate);
                return session.snapshot();
            } catch (Exception error) {
                portLeases.release(session.id(), port);
                throw error;
            }
        }
    }

    public MachineStatusSnapshot disconnect(String id) {
        ControllerSession session = require(id);
        synchronized (session) {
            String port = session.port();
            session.disconnect();
            portLeases.release(session.id(), port);
            return session.snapshot();
        }
    }

    public MachineStatusSnapshot home(String id) throws Exception {
        ControllerSession session = require(id);
        session.home();
        return session.snapshot();
    }

    public MachineStatusSnapshot jog(String id, double x, double y, double z, double feedRate) throws Exception {
        ControllerSession session = require(id);
            session.jog(x, y, z, feedRate);
            return session.snapshot();
    }

    public MachineStatusSnapshot command(String id, String command) throws Exception {
        ControllerSession session = require(id);
        session.command(command);
        return session.snapshot();
    }

    public MachineStatusSnapshot reset(String id) throws Exception {
        ControllerSession session = require(id);
        session.reset();
        return session.snapshot();
    }

    public MachineStatusSnapshot unlock(String id) throws Exception {
        ControllerSession session = require(id);
        session.unlock();
        return session.snapshot();
    }

    public List<FirmwareSetting> settings(String id, boolean refresh) throws Exception {
        return require(id).settings(refresh);
    }

    public FirmwareSetting setSetting(String id, String key, String value) throws Exception {
        ControllerSession session = require(id);
        return session.setSetting(key, value);
    }

    public MachineStatusSnapshot applySettings(String id, java.util.Map<String, String> settings) throws Exception {
        ControllerSession session = require(id);
        session.applySettings(settings);
        return session.snapshot();
    }

    public MachineStatusSnapshot setWorkZero(String id, String axis) throws Exception {
        ControllerSession session = require(id);
        session.setWorkZero(axis);
        return session.snapshot();
    }

    public MachineStatusSnapshot setWorkOffset(String id, Double x, Double y, Double z) throws Exception {
        ControllerSession session = require(id);
        session.setWorkOffset(x, y, z);
        return session.snapshot();
    }

    public MachineStatusSnapshot startStream(String id, String gcode) throws Exception {
        ControllerSession session = require(id);
        session.startStream(gcode);
        return session.snapshot();
    }

    public MachineStatusSnapshot pauseStream(String id) throws Exception {
        ControllerSession session = require(id);
        session.pauseStream();
        return session.snapshot();
    }

    public MachineStatusSnapshot resumeStream(String id) throws Exception {
        ControllerSession session = require(id);
        session.resumeStream();
        return session.snapshot();
    }

    public MachineStatusSnapshot stopStream(String id) throws Exception {
        ControllerSession session = require(id);
        session.stopStream();
        return session.snapshot();
    }

    public synchronized void disconnectAll() {
        for (ControllerSession session : sessions()) {
            try {
                disconnect(session.id());
            } catch (RuntimeException error) {
                events.publish(
                    "controller.error",
                    session.id(),
                    "Disconnect warning: " + error.getMessage(),
                    "warning",
                    session.snapshot()
                );
            }
        }
    }

    public List<SerialPortDto> listPorts() {
        List<SerialPortDto> ports = new ArrayList<>();
        for (IConnectionDevice device : ConnectionFactory.getDevices(ConnectionDriver.JSERIALCOMM)) {
            ports.add(new SerialPortDto(
                device.getAddress(),
                device.getAddress(),
                device.getDescription().orElse(null),
                device.getManufacturer().orElse(null),
                portLeases.ownerOf(device.getAddress()).orElse(null)
            ));
        }
        return ports;
    }

    public AgentState state() {
        List<MachineStatusSnapshot> heads = sessions().stream().map(ControllerSession::snapshot).toList();
        MachineStatusSnapshot active = heads.stream().filter(MachineStatusSnapshot::connected).findFirst()
            .orElse(heads.get(0));
        return new AgentState(heads, active);
    }

    public MachineStatusSnapshot status(String id) {
        return require(id).snapshot();
    }

    public void connectForAutomation(String id, String port, int baudRate) throws Exception {
        ControllerSession session = require(id);

        if (port == null || port.isBlank()) {
            throw new IllegalArgumentException("A serial port is required.");
        }

        if (session.isConnected()) {
            if (!session.port().equalsIgnoreCase(port.trim()) || session.baudRate() != baudRate) {
                throw new IllegalStateException(
                    session.id()
                        + " is already connected to "
                        + session.port()
                        + " at "
                        + session.baudRate()
                        + " baud. Disconnect it before starting this drawing."
                );
            }

            session.unlockIfAlarm();
            return;
        }

        connect(id, port, baudRate);
    }

    public void unlockIfAlarm(String id) throws Exception {
        require(id).unlockIfAlarm();
    }

    public void homeAndWait(String id, long timeoutMillis, BooleanSupplier canceled) throws Exception {
        ControllerSession session = require(id);
        long deadline = deadline(timeoutMillis);
        long generation = session.home(remainingMillis(deadline));
        waitFor(id, "homing", deadline, canceled, () -> session.homeCompleted(generation));
    }

    public void jogAndWait(
        String id,
        double x,
        double y,
        double z,
        double feedRate,
        long timeoutMillis,
        BooleanSupplier canceled
    ) throws Exception {
        ControllerSession session = require(id);
        long deadline = deadline(timeoutMillis);
        MachineStatusSnapshot before = session.snapshot(remainingMillis(deadline));
        long generation = session.jog(x, y, z, feedRate, remainingMillis(deadline));
        boolean seenBusy = false;
        int stableIdleSamples = 0;
        while (System.nanoTime() < deadline) {
            MachineStatusSnapshot current = session.snapshot(remainingMillis(deadline));
            ensureCanContinue(id, "setup movement", canceled, current);
            if (session.jogRejected(generation)) {
                throw new IllegalStateException(id + " rejected the setup movement.");
            }
            boolean idle = "IDLE".equalsIgnoreCase(current.state());
            if (!idle) seenBusy = true;
            boolean positionChanged = !samePosition(before.machinePosition(), current.machinePosition());
            if (session.jogAccepted(generation) && idle && (seenBusy || positionChanged)) {
                stableIdleSamples++;
                // CRITICAL FIX: Increased from 3 (300ms) to 10 (1000ms) to ensure status polling
                // has enough time to update position after jog completion, preventing race conditions
                // when multiple heads request status simultaneously
                if (stableIdleSamples >= 10) return;
            } else {
                stableIdleSamples = 0;
            }
            sleepPoll();
        }
        throw new IllegalStateException("Timed out waiting for " + id + " setup movement to complete.");
    }

    public void setWorkZeroAndWait(String id, long timeoutMillis, BooleanSupplier canceled) throws Exception {
        ControllerSession session = require(id);
        long deadline = deadline(timeoutMillis);
        session.setWorkZero("ALL", remainingMillis(deadline));
        while (System.nanoTime() < deadline) {
            MachineStatusSnapshot current = session.snapshot(remainingMillis(deadline));
            ensureCanContinue(id, "work-zero", canceled, current);
            MachineStatusSnapshot.PositionDto work = current.workPosition();
            if (nearZero(work)) return;
            sleepPoll();
        }
        throw new IllegalStateException("Timed out verifying the work-zero position on " + id + ".");
    }

    public void streamAndWait(String id, String gcode, long timeoutMillis, BooleanSupplier canceled) throws Exception {
        ControllerSession session = require(id);
        long deadline = deadline(timeoutMillis);
        long generation = session.startStream(gcode, remainingMillis(deadline));
        waitFor(id, "G-code stream", deadline, canceled, () -> {
            if (session.streamCanceled(generation)) {
                throw new IllegalStateException(id + " G-code stream was canceled.");
            }
            return session.streamCompleted(generation)
                && session.snapshot(remainingMillis(deadline)).rowsRemaining() == 0;
        });
    }

    public void abortAutomationMotion(String id) {
        ControllerSession session = require(id);
        if (!session.isConnected()) return;
        try {
            session.stopStream();
        } catch (Exception ignored) {
            // A non-streaming controller commonly rejects cancelSend.
        }
        try {
            session.reset();
        } catch (Exception error) {
            events.publish("controller.error", session.id(), "Abort warning: " + safeMessage(error), "warning", session.snapshot());
        }
    }

    public void disconnectAutomationSessions() {
        for (ControllerSession session : sessions()) {
            String port = session.port();
            session.shutdownAndReset();
            portLeases.release(session.id(), port);
            disconnectStrikes.remove(session.id());
        }
    }

    private void waitFor(
        String id,
        String operation,
        long deadline,
        BooleanSupplier canceled,
        CheckedCondition completed
    ) throws Exception {
        while (System.nanoTime() < deadline) {
            MachineStatusSnapshot current = require(id).snapshot(remainingMillis(deadline));
            ensureCanContinue(id, operation, canceled, current);
            if (completed.test()) return;
            sleepPoll();
        }
        throw new IllegalStateException("Timed out waiting for " + id + " " + operation + " to complete.");
    }

    private void ensureCanContinue(String id, String operation, BooleanSupplier canceled) {
        ensureCanContinue(id, operation, canceled, status(id));
    }

    void ensureCanContinue(
        String id,
        String operation,
        BooleanSupplier canceled,
        MachineStatusSnapshot status
    ) {
        if (canceled.getAsBoolean()) throw new java.util.concurrent.CancellationException("Drawing aborted by the operator.");
        if (!status.connected()) {
            int strikes = disconnectStrikes.merge(id, 1, Integer::sum);
            if (strikes >= DISCONNECT_CONFIRM_STRIKES) {
                disconnectStrikes.remove(id);
                throw new IllegalStateException(id + " disconnected during " + operation + ".");
            }
        } else {
            disconnectStrikes.remove(id);
        }
        if (status.alarm() != null || "ALARM".equalsIgnoreCase(status.state())) {
            throw new IllegalStateException(id + " entered an alarm state during " + operation + ".");
        }
    }

    private boolean nearZero(MachineStatusSnapshot.PositionDto position) {
        return position != null
            && nearZero(position.x())
            && nearZero(position.y())
            && nearZero(position.z());
    }

    private boolean nearZero(Double value) {
        return value != null && Math.abs(value) <= 0.01d;
    }

    private boolean samePosition(MachineStatusSnapshot.PositionDto left, MachineStatusSnapshot.PositionDto right) {
        if (left == null || right == null) return false;

        return nearSame(left.x(), right.x())
            && nearSame(left.y(), right.y())
            && nearSame(left.z(), right.z());
    }

    private boolean nearSame(Double left, Double right) {
        if (left == null || right == null) {
            return left == right;
        }

        return Math.abs(left - right) <= 0.001d;
    }

    private long elapsedMillis(long startedNanos) {
        return (System.nanoTime() - startedNanos) / 1_000_000L;
    }

    private long deadline(long timeoutMillis) {
        return System.nanoTime() + Math.max(1L, timeoutMillis) * 1_000_000L;
    }

    private long remainingMillis(long deadline) {
        long remainingNanos = deadline - System.nanoTime();
        if (remainingNanos <= 0) throw new IllegalStateException("Controller operation deadline exceeded.");
        return Math.max(1L, (remainingNanos + 999_999L) / 1_000_000L);
    }

    private void sleepPoll() throws InterruptedException {
        // CRITICAL FIX: Reduced from 100ms to 50ms to make status polling more responsive
        // and catch position updates faster, especially when multiple heads request status simultaneously
        Thread.sleep(50);
    }

    private String safeMessage(Exception error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    @FunctionalInterface
    private interface CheckedCondition {
        boolean test() throws Exception;
    }

    private void validateExistingPort(String requestedPort) {
        boolean exists = listPorts().stream()
            .anyMatch(port -> port.path().equalsIgnoreCase(requestedPort.trim()));
        if (!exists) throw new IllegalArgumentException("Serial port " + requestedPort + " was not detected.");
    }

    private String normalizeId(String candidate) {
        if (candidate == null) return "";
        String normalized = candidate.trim().toLowerCase(Locale.ROOT);
        if ("1".equals(normalized) || "head1".equals(normalized)) return "head-1";
        if ("2".equals(normalized) || "head2".equals(normalized)) return "head-2";
        return normalized;
    }

    private void validateBaudRate(int baudRate) {
        if (baudRate < 1200 || baudRate > 2_000_000) {
            throw new IllegalArgumentException("Baud rate must be between 1200 and 2000000.");
        }
    }

    public record SerialPortDto(String path, String address, String description, String manufacturer, String inUseBy) {}
    public record AgentState(List<MachineStatusSnapshot> heads, MachineStatusSnapshot machine) {}
}