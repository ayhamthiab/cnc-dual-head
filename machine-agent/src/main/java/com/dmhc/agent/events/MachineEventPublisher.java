package com.dmhc.agent.events;

import com.google.gson.Gson;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Small Server-Sent Events fan-out. SSE is intentionally used instead of a
 * WebSocket dependency: it is sufficient for status/telemetry and remains
 * easy to run locally through a browser.
 */
public final class MachineEventPublisher {
    private static final int CLIENT_QUEUE_CAPACITY = 256;
    private static final ExecutorService CLIENT_CLEANUP = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "dmhc-machine-events-cleanup");
        thread.setDaemon(true);
        return thread;
    });
    private final Gson gson = new Gson();
    private final Map<OutputStream, ClientSink> clients = new ConcurrentHashMap<>();

    public void subscribe(OutputStream client) {
        clients.computeIfAbsent(client, output -> new ClientSink(output, this));
    }

    public void unsubscribe(OutputStream client) {
        ClientSink sink = clients.remove(client);
        if (sink != null) removeAsync(sink);
    }

    public void publish(String event, String controllerId, String message, String level, Object data) {
        MachineEvent envelope = new MachineEvent(
            event,
            controllerId,
            message,
            level,
            Instant.now().toString(),
            data
        );
        byte[] bytes = ("data: " + gson.toJson(envelope) + "\n\n").getBytes(StandardCharsets.UTF_8);
        for (ClientSink sink : clients.values()) {
            if (!sink.offer(bytes) && clients.remove(sink.output, sink)) removeAsync(sink);
        }
    }

    public void keepAlive(OutputStream client, Instant time) {
        ClientSink sink = clients.get(client);
        if (sink == null) return;
        byte[] bytes = (": keepalive " + time + "\n\n").getBytes(StandardCharsets.UTF_8);
        if (!sink.offer(bytes) && clients.remove(client, sink)) removeAsync(sink);
    }

    private void removeAsync(ClientSink sink) {
        sink.stop();
        CLIENT_CLEANUP.execute(sink::closeOutput);
    }

    private static final class ClientSink implements Runnable {
        private final OutputStream output;
        private final MachineEventPublisher owner;
        private final ArrayBlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(CLIENT_QUEUE_CAPACITY);
        private final Thread worker;
        private volatile boolean running = true;

        private ClientSink(OutputStream output, MachineEventPublisher owner) {
            this.output = output;
            this.owner = owner;
            this.worker = new Thread(this, "dmhc-machine-events");
            this.worker.setDaemon(true);
            this.worker.start();
        }

        private boolean offer(byte[] bytes) {
            return running && queue.offer(bytes);
        }

        private void stop() {
            running = false;
            worker.interrupt();
            queue.clear();
        }

        private void closeOutput() {
            try {
                output.close();
            } catch (IOException ignored) {
                // The browser already closed its local event stream.
            }
        }

        @Override
        public void run() {
            try {
                while (running) {
                    byte[] bytes = queue.take();
                    synchronized (output) {
                        output.write(bytes);
                        output.flush();
                    }
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } catch (IOException error) {
                if (owner.clients.remove(output, this)) owner.removeAsync(this);
            }
        }
    }

    public record MachineEvent(
        String event,
        String controllerId,
        String message,
        String level,
        String timestamp,
        Object data
    ) {}
}