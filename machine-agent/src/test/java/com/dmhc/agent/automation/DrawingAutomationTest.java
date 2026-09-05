package com.dmhc.agent.automation;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.locks.LockSupport;
import java.util.function.BooleanSupplier;

import org.junit.jupiter.api.AfterEach;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import org.junit.jupiter.api.Test;

import com.dmhc.agent.controller.MachineStatusSnapshot;
import com.dmhc.agent.events.MachineEventPublisher;

class DrawingAutomationTest {
    private DrawingAutomation automation;

    @AfterEach
    void shutdown() {
        if (automation != null) automation.shutdown();
    }

    @Test
    void runsTheExactTwoHeadSequenceAndGapFillOnHeadOne() throws Exception {
        FakeMachine machine = new FakeMachine();
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        AutomationSnapshot completed = awaitTerminal();

        assertEquals("COMPLETED", completed.status());
        assertEquals("connect:head-1:COM9:115200", machine.operations.get(0));
        assertEquals("connect:head-2:COM6:115200", machine.operations.get(1));
        assertEquals(List.of(
            "home:head-1",
            "zero:head-1",
            "jog:head-1:X:-30.0:1000.0",
            "jog:head-1:Z:-199.0:1000.0",
            "zero:head-1",
            "stream:head-1:HEAD1",
            "stream:head-1:GAP",
            "home:head-1"
        ), machine.operations.stream().filter(value -> value.contains("head-1")).skip(1).toList());
        assertEquals(List.of(
            "home:head-2",
            "zero:head-2",
            "jog:head-2:X:-45.0:1000.0",
            "jog:head-2:Z:-208.5:1000.0",
            "zero:head-2",
            "stream:head-2:HEAD2",
            "home:head-2",
            "home:head-2"
        ), machine.operations.stream().filter(value -> value.contains("head-2")).skip(1).toList());
    }

    @Test
    void initialHomingAndSetupOriginOpenBothHeadOperationsAtTheSameTime() throws Exception {
        ParallelTimingMachine machine = new ParallelTimingMachine();
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        awaitTerminal();

        assertTrue(Math.abs(machine.timeFor("home:head-1") - machine.timeFor("home:head-2")) < 100_000_000L);
        assertTrue(Math.abs(machine.timeFor("jog:head-1:X:-30.0:1000.0") - machine.timeFor("jog:head-2:X:-45.0:1000.0")) < 100_000_000L);
        assertTrue(Math.abs(machine.timeFor("jog:head-1:Z:-199.0:1000.0") - machine.timeFor("jog:head-2:Z:-208.5:1000.0")) < 100_000_000L);
        assertTrue(Math.abs(machine.timeFor("zero:head-1") - machine.timeFor("zero:head-2")) < 100_000_000L);
    }

    @Test
    void normalCompletionCanBeFollowedByAnotherRun() throws Exception {
        FakeMachine machine = new FakeMachine();
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        assertEquals("COMPLETED", awaitTerminal().status());
        automation.start(request());
        assertEquals("COMPLETED", awaitTerminal().status());

        assertEquals(4, machine.operations.stream().filter(value -> value.startsWith("connect:")).count());
    }

    @Test
    void abortResetsBothHeadsBeforeTheNextRun() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.blockMainStreams = true;
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        if (!machine.mainStreamsStarted.await(1, java.util.concurrent.TimeUnit.SECONDS)) {
            throw new AssertionError("Main streams did not start.");
        }
        assertEquals("ABORTING", automation.abort().status());
        assertEquals("CANCELED", awaitTerminal(7_000).status());
        assertTrue(machine.operations.contains("disconnect:all"));

        machine.blockMainStreams = false;
        automation.start(request());
        assertEquals("COMPLETED", awaitTerminal().status());
    }

    @Test
    void terminalControllerFailureResetsBeforeTheNextRun() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.failOn = "stream:head-2:HEAD2";
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        assertEquals("FAILED", awaitTerminal(7_000).status());
        assertTrue(machine.operations.contains("disconnect:all"));

        machine.failOn = null;
        automation.start(request());
        assertEquals("COMPLETED", awaitTerminal().status());
    }

    @Test
    void pauseAndResumeKeepTheSameRunAndConnection() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.blockMainStreams = true;
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        if (!machine.mainStreamsStarted.await(1, java.util.concurrent.TimeUnit.SECONDS)) {
            throw new AssertionError("Main streams did not start.");
        }
        assertEquals("PAUSED", automation.pause().status());
        assertTrue(machine.operations.contains("pause:head-1"));
        assertTrue(machine.operations.contains("pause:head-2"));
        assertEquals("RUNNING", automation.resume().status());
        assertTrue(machine.operations.contains("resume:head-1"));
        assertTrue(machine.operations.contains("resume:head-2"));
        machine.releaseMainStreams.countDown();

        assertEquals("COMPLETED", awaitTerminal().status());
        assertTrue(machine.operations.stream().noneMatch(value -> value.equals("disconnect:all")));
    }

    @Test
    void startIsRejectedWhileAbortResetIsStillRunning() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.blockMainStreams = true;
        machine.blockCleanup = true;
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        if (!machine.mainStreamsStarted.await(1, java.util.concurrent.TimeUnit.SECONDS)) {
            throw new AssertionError("Main streams did not start.");
        }
        automation.abort();
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, () -> automation.start(request()));
    }

    @Test
    void aFailureStopsLaterStagesAndAbortsBothHeads() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.failOn = "stream:head-2:HEAD2";
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        AutomationSnapshot failed = awaitTerminal();

        assertEquals("FAILED", failed.status());
        assertTrue(failed.error().contains("simulated failure"));
        assertTrue(machine.operations.contains("abort:head-1"));
        assertTrue(machine.operations.contains("abort:head-2"));
        assertTrue(machine.operations.stream().noneMatch(value -> value.equals("stream:head-1:GAP")));
    }

    @Test
    void aHungHeadDoesNotKeepTheTwoHeadAutomationRunningForever() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.hangOn = "jog:head-1:Z:-199.0:1000.0";
        automation = new DrawingAutomation(machine, new MachineEventPublisher(), 100L);

        automation.start(request());
        AutomationSnapshot failed = awaitTerminal();

        assertEquals("FAILED", failed.status());
        assertTrue(failed.error().contains("timed out during setup Z movement"));
        assertTrue(machine.operations.contains("jog:head-2:Z:-208.5:1000.0"));
        awaitOperation(machine, "abort:head-1");
        awaitOperation(machine, "abort:head-2");
        assertTrue(machine.operations.contains("abort:head-1"));
        assertTrue(machine.operations.contains("abort:head-2"));
    }

    @Test
    void aHungCleanupDoesNotPreventFailurePublication() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.failOn = "jog:head-2:Z:-208.5:1000.0";
        machine.hangCleanup = true;
        automation = new DrawingAutomation(machine, new MachineEventPublisher(), 100L);

        automation.start(request());
        AutomationSnapshot failed = awaitTerminal(7_000);

        assertEquals("FAILED", failed.status());
        assertTrue(failed.error().contains("simulated failure"));
    }

    @Test
    void clearsOnlyHeadOneWhenHeadOneReportsAnAlarmBeforeMotion() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.alarmHead = "head-1";
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        AutomationSnapshot completed = awaitTerminal();

        assertEquals("COMPLETED", completed.status());
        assertTrue(machine.operations.contains("unlock:head-1"));
        assertTrue(machine.operations.stream().noneMatch(value -> value.equals("unlock:head-2")));
        assertTrue(
            machine.operations.indexOf("unlock:head-1")
                < machine.operations.indexOf("home:head-1")
        );
    }

    @Test
    void clearsOnlyTheHeadThatReportsAnAlarmBeforeMotion() throws Exception {
        FakeMachine machine = new FakeMachine();
        machine.alarmHead = "head-2";
        automation = new DrawingAutomation(machine, new MachineEventPublisher());

        automation.start(request());
        AutomationSnapshot completed = awaitTerminal();

        assertEquals("COMPLETED", completed.status());
        assertTrue(machine.operations.contains("unlock:head-2"));
        assertTrue(machine.operations.stream().noneMatch(value -> value.equals("unlock:head-1")));
        assertTrue(
            machine.operations.indexOf("unlock:head-2")
                < machine.operations.indexOf("home:head-2")
        );
    }

    private AutomationSnapshot awaitTerminal() throws InterruptedException {
        return awaitTerminal(2_000);
    }

    private AutomationSnapshot awaitTerminal(long timeoutMillis) throws InterruptedException {
        long deadline = System.nanoTime() + timeoutMillis * 1_000_000L;
        while (System.nanoTime() < deadline) {
            AutomationSnapshot snapshot = automation.snapshot();
            if (List.of("COMPLETED", "FAILED", "CANCELED").contains(snapshot.status())) return snapshot;
            Thread.sleep(10);
        }
        throw new AssertionError("Automation did not reach a terminal state.");
    }

    private AutomationRequest request() {
        return new AutomationRequest("job-1", "drawing.nc", "COM9", "COM6", 115200, "HEAD1", "HEAD2", "GAP", -30d, -199d, -45d, -208.5d);
    }

    private void awaitOperation(FakeMachine machine, String operation) throws InterruptedException {
        for (int index = 0; index < 100; index++) {
            if (machine.operations.contains(operation)) return;
            Thread.sleep(10);
        }
        throw new AssertionError("Operation was not recorded: " + operation);
    }

    private static final class ParallelTimingMachine implements DrawingAutomation.AutomationMachine {
        private final List<String> operations = new CopyOnWriteArrayList<>();
        private final java.util.Map<String, Long> times = new java.util.concurrent.ConcurrentHashMap<>();

        @Override
        public MachineStatusSnapshot status(String id) {
            int head = "head-1".equals(id) ? 1 : 2;
            String port = head == 1 ? "COM9" : "COM6";
            return new MachineStatusSnapshot(
                id, head, true, port, 115200, "CONNECTED", null,
                null, new MachineStatusSnapshot.PositionDto(0d, 0d, 0d), null,
                0d, 0d, "GRBL 1.1", null, null, 1, 1, 0, null
            );
        }

        @Override
        public void connect(String id, String port, int baudRate) {
            recordOperation("connect:" + id + ":" + port + ":" + baudRate);
        }

        @Override
        public void unlockIfAlarm(String id) {
            recordOperation("unlock:" + id);
        }

        @Override
        public void homeAndWait(String id, long timeoutMillis, BooleanSupplier canceled) throws InterruptedException {
            recordOperation("home:" + id);
            Thread.sleep(150L);
        }

        @Override
        public void jogAndWait(
            String id, double x, double y, double z, double feedRate, long timeoutMillis, BooleanSupplier canceled
        ) throws InterruptedException {
            String axis = x != 0 ? "X:" + x : y != 0 ? "Y:" + y : "Z:" + z;
            recordOperation("jog:" + id + ":" + axis + ":" + feedRate);
            Thread.sleep(150L);
        }

        @Override
        public void setWorkZeroAndWait(String id, long timeoutMillis, BooleanSupplier canceled) throws InterruptedException {
            recordOperation("zero:" + id);
            Thread.sleep(150L);
        }

        @Override
        public void streamAndWait(String id, String gcode, long timeoutMillis, BooleanSupplier canceled) throws InterruptedException {
            recordOperation("stream:" + id + ":" + gcode);
            Thread.sleep(150L);
        }

        @Override
        public void pauseStream(String id) {
            recordOperation("pause:" + id);
        }

        @Override
        public void resumeStream(String id) {
            recordOperation("resume:" + id);
        }

        @Override
        public void abortAutomationMotion(String id) {
            recordOperation("abort:" + id);
        }

        @Override
        public void disconnectAutomationSessions() {
            operations.add("disconnect:all");
        }

        private void recordOperation(String operation) {
            operations.add(operation);
            times.putIfAbsent(operation, System.nanoTime());
        }

        long timeFor(String operation) {
            return times.get(operation);
        }
    }

    private static final class FakeMachine implements DrawingAutomation.AutomationMachine {
        private final List<String> operations = new CopyOnWriteArrayList<>();
        private volatile String failOn;
        private volatile String alarmHead;
        private volatile String hangOn;
        private volatile boolean hangCleanup;
        private volatile boolean blockMainStreams;
        private volatile boolean blockCleanup;
        private final java.util.Set<String> pausedHeads = java.util.concurrent.ConcurrentHashMap.newKeySet();
        private final CountDownLatch mainStreamsStarted = new CountDownLatch(2);
        private final CountDownLatch releaseMainStreams = new CountDownLatch(1);

        @Override
        public MachineStatusSnapshot status(String id) {
            int head = "head-1".equals(id) ? 1 : 2;
            String port = head == 1 ? "COM9" : "COM6";
            boolean alarm = id.equals(alarmHead);
            return new MachineStatusSnapshot(
                id, head, true, port, 115200, "CONNECTED", alarm ? "ALARM" : pausedHeads.contains(id) ? "HOLD" : "IDLE",
                null, new MachineStatusSnapshot.PositionDto(0d, 0d, 0d), null,
                0d, 0d, "GRBL 1.1", alarm ? "ALARM" : null, null, 1, 1, 0, null
            );
        }

        @Override
        public void connect(String id, String port, int baudRate) {
            record("connect:" + id + ":" + port + ":" + baudRate);
        }

        @Override
        public void unlockIfAlarm(String id) {
            if (!id.equals(alarmHead)) return;
            record("unlock:" + id);
            alarmHead = null;
        }

        @Override
        public void homeAndWait(String id, long timeoutMillis, BooleanSupplier canceled) {
            record("home:" + id);
        }

        @Override
        public void jogAndWait(
            String id, double x, double y, double z, double feedRate, long timeoutMillis, BooleanSupplier canceled
        ) {
            String axis = x != 0 ? "X:" + x : y != 0 ? "Y:" + y : "Z:" + z;
            String operation = "jog:" + id + ":" + axis + ":" + feedRate;
            record(operation);
            if (operation.equals(hangOn)) {
                while (true) LockSupport.park();
            }
        }

        @Override
        public void setWorkZeroAndWait(String id, long timeoutMillis, BooleanSupplier canceled) {
            record("zero:" + id);
        }

        @Override
        public void streamAndWait(String id, String gcode, long timeoutMillis, BooleanSupplier canceled) throws InterruptedException {
            record("stream:" + id + ":" + gcode);
            if (blockMainStreams && ("HEAD1".equals(gcode) || "HEAD2".equals(gcode))) {
                mainStreamsStarted.countDown();
                releaseMainStreams.await();
            }
        }

        @Override
        public void pauseStream(String id) {
            record("pause:" + id);
            pausedHeads.add(id);
        }

        @Override
        public void resumeStream(String id) {
            record("resume:" + id);
            pausedHeads.remove(id);
        }

        @Override
        public void abortAutomationMotion(String id) {
            operations.add("abort:" + id);
            if (hangCleanup || blockCleanup) while (true) LockSupport.park();
        }

        @Override
        public void disconnectAutomationSessions() {
            operations.add("disconnect:all");
        }

        private void record(String operation) {
            operations.add(operation);
            if (operation.equals(failOn)) throw new IllegalStateException("simulated failure at " + operation);
        }
    }
}
