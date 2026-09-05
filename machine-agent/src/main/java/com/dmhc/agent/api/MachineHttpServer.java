package com.dmhc.agent.api;

import com.dmhc.agent.automation.AutomationRequest;
import com.dmhc.agent.automation.DrawingAutomation;
import com.dmhc.agent.config.AgentConfig;
import com.dmhc.agent.controller.ControllerRegistry;
import com.dmhc.agent.controller.MachineStatusSnapshot;
import com.dmhc.agent.events.MachineEventPublisher;
import com.dmhc.agent.profile.MachineProfileStore;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.willwinder.universalgcodesender.firmware.FirmwareSetting;
import com.willwinder.universalgcodesender.firmware.FirmwareSettingsException;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * Intentionally small local HTTP/SSE API. It is not exposed through the
 * cloud service and always binds to loopback through {@link AgentConfig}.
 */
public final class MachineHttpServer {
    private static final int MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;
    private final AgentConfig config;
    private final ControllerRegistry controllers;
    private final MachineEventPublisher events;
    private final MachineProfileStore profiles;
    private final DrawingAutomation automation;
    private final Gson gson = new Gson();
    private final HttpServer server;

    public MachineHttpServer(AgentConfig config, ControllerRegistry controllers, MachineEventPublisher events)
        throws IOException {
        this.config = config;
        this.controllers = controllers;
        this.events = events;
        this.profiles = new MachineProfileStore(
            Path.of(System.getProperty("user.home"), ".dmhc-machine-agent", "profiles.json")
        );
        this.automation = new DrawingAutomation(controllers, events);
        this.server = HttpServer.create(new InetSocketAddress(config.host(), config.port()), 0);
        this.server.createContext("/", this::handle);
        this.server.setExecutor(Executors.newCachedThreadPool());
    }

    public void start() {
        server.start();
    }

    public void stop() {
        automation.shutdown();
        server.stop(1);
    }

    private void handle(HttpExchange exchange) throws IOException {
        String origin = exchange.getRequestHeaders().getFirst("Origin");
        if (!originAllowed(origin)) {
            respond(exchange, 403, Map.of("error", "Origin is not permitted to access the local agent."));
            return;
        }
        addCorsHeaders(exchange.getResponseHeaders(), origin);

        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
            return;
        }

        String path = removeApiPrefix(exchange.getRequestURI().getPath());
        try {
            // The unauthenticated health endpoint lets the UI report whether
            // a local agent is present; all serial and controller operations
            // require the browser-local bearer token.
            if ("GET".equals(exchange.getRequestMethod()) && ("/health".equals(path) || "/agent/status".equals(path))) {
                respond(exchange, 200, health());
                return;
            }
            if (!authorized(exchange)) {
                respond(exchange, 401, Map.of("error", "Missing or invalid agent token."));
                return;
            }

            if ("GET".equals(exchange.getRequestMethod()) && ("/serial-ports".equals(path) || "/ports".equals(path))) {
                respond(exchange, 200, Map.of("ports", controllers.listPorts()));
                return;
            }
            if ("GET".equals(exchange.getRequestMethod()) && "/profiles".equals(path)) {
                respond(exchange, 200, Map.of("profiles", profiles.list()));
                return;
            }
            if ("POST".equals(exchange.getRequestMethod()) && "/profiles".equals(path)) {
                respond(exchange, 200, saveProfile(readJson(exchange)));
                return;
            }
            if ("DELETE".equals(exchange.getRequestMethod()) && path.startsWith("/profiles/")) {
                profiles.delete(path.substring("/profiles/".length()));
                respond(exchange, 200, Map.of("deleted", true));
                return;
            }
            if ("GET".equals(exchange.getRequestMethod()) && ("/controllers".equals(path) || "/status".equals(path))) {
                respond(exchange, 200, controllerState());
                return;
            }
            if ("GET".equals(exchange.getRequestMethod()) && "/events".equals(path)) {
                streamEvents(exchange);
                return;
            }
            if ("GET".equals(exchange.getRequestMethod()) && "/automation/status".equals(path)) {
                respond(exchange, 200, automation.snapshot());
                return;
            }
            if ("POST".equals(exchange.getRequestMethod()) && path.startsWith("/automation/")) {
                JsonObject body = readJson(exchange);
                String action = path.substring("/automation/".length());
                respond(exchange, 200, performAutomation(action, body));
                return;
            }

            Route route = Route.parse(path);
            if (route != null && "GET".equals(exchange.getRequestMethod()) && "status".equals(route.action())) {
                respond(exchange, 200, controllers.status(route.controllerId()));
                return;
            }
            if (route != null && "GET".equals(exchange.getRequestMethod()) && "settings".equals(route.action())) {
                boolean refresh = "true".equalsIgnoreCase(queryParams(exchange.getRequestURI()).getOrDefault("refresh", "false"));
                respond(exchange, 200, Map.of(
                    "settings", controllers.settings(route.controllerId(), refresh),
                    "refreshed", refresh
                ));
                return;
            }
            if (route == null || !"POST".equals(exchange.getRequestMethod())) {
                respond(exchange, 404, Map.of("error", "Unknown local-agent endpoint."));
                return;
            }
            JsonObject body = readJson(exchange);
            respond(exchange, 200, perform(route, body));
        } catch (IllegalArgumentException | IllegalStateException | FirmwareSettingsException error) {
            respond(exchange, 400, Map.of("error", safeMessage(error)));
        } catch (Exception error) {
            error.printStackTrace(System.err);
            respond(exchange, 500, Map.of("error", "Agent operation failed: " + safeMessage(error)));
        }
    }

    private Object perform(Route route, JsonObject body) throws Exception {
        if (automation.isActive()) {
            throw new IllegalStateException(
                "Manual controller actions are locked while an automated drawing is active. Use the Automated Run pause or abort controls."
            );
        }
        if ("connect".equals(route.action())) {
            String port = requiredString(body, "port");
            int baudRate = optionalInt(body, "baudRate", 115200);
            MachineStatusSnapshot snapshot = controllers.connect(route.controllerId(), port, baudRate);
            return Map.of(
                "head", snapshot.head(),
                "controllerId", snapshot.controllerId(),
                "connected", snapshot.connected(),
                "firmware", snapshot.firmware() == null ? "" : snapshot.firmware(),
                "status", snapshot
            );
        }
        if ("disconnect".equals(route.action())) return controllers.disconnect(route.controllerId());

        requireConfirmation(body, route.action());
        return switch (route.action()) {
            case "home" -> controllers.home(route.controllerId());
            case "jog" -> controllers.jog(
                route.controllerId(),
                optionalDouble(body, "x", 0),
                optionalDouble(body, "y", 0),
                optionalDouble(body, "z", 0),
                requiredPositiveDouble(body, "feedRate")
            );
            case "command" -> controllers.command(route.controllerId(), validCommand(requiredString(body, "command")));
            case "reset" -> controllers.reset(route.controllerId());
            case "unlock" -> controllers.unlock(route.controllerId());
            case "work-zero" -> controllers.setWorkZero(
                route.controllerId(), optionalString(body, "axis", "ALL")
            );
            case "work-offset" -> controllers.setWorkOffset(
                route.controllerId(),
                optionalNullableDouble(body, "x"),
                optionalNullableDouble(body, "y"),
                optionalNullableDouble(body, "z")
            );
            case "settings" -> {
                FirmwareSetting updated = controllers.setSetting(
                    route.controllerId(), requiredString(body, "key"), requiredString(body, "value")
                );
                yield Map.of("setting", updated, "status", controllers.status(route.controllerId()));
            }
            case "setup" -> controllers.applySettings(route.controllerId(), validatedSetupSettings(requiredSettings(body)));
            case "stream" -> controllers.startStream(route.controllerId(), validGcode(requiredString(body, "gcode")));
            case "pause" -> controllers.pauseStream(route.controllerId());
            case "resume" -> controllers.resumeStream(route.controllerId());
            case "stop" -> controllers.stopStream(route.controllerId());
            default -> throw new IllegalArgumentException("Unsupported controller action: " + route.action());
        };
    }

    private Object performAutomation(String action, JsonObject body) throws Exception {
        return switch (action) {
            case "start" -> {
                requireConfirmation(body, "automated drawing");
                yield automation.start(new AutomationRequest(
                    requiredString(body, "jobId"),
                    requiredString(body, "filename"),
                    requiredString(body, "head1Port"),
                    requiredString(body, "head2Port"),
                    optionalInt(body, "baudRate", 115200),
                    validGcode(requiredString(body, "head1Gcode")),
                    validGcode(requiredString(body, "head2Gcode")),
                    validGcode(requiredString(body, "gapFillGcode")),
                    optionalDouble(body, "head1OffsetX", -41d),
                    optionalDouble(body, "head1OffsetZ", -196d),
                    optionalDouble(body, "head2OffsetX", -60d),
                    optionalDouble(body, "head2OffsetZ", -201d)
                ));
            }
            case "pause" -> {
                requireConfirmation(body, "automation pause");
                yield automation.pause();
            }
            case "resume" -> {
                requireConfirmation(body, "automation resume");
                yield automation.resume();
            }
            case "abort" -> {
                requireConfirmation(body, "automation abort");
                yield automation.abort();
            }
            default -> throw new IllegalArgumentException("Unsupported automation action: " + action);
        };
    }

    private Map<String, Object> health() {
        ControllerRegistry.AgentState state = controllers.state();
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("name", "DMHC Local Machine Agent");
        response.put("version", "0.1.0");
        response.put("localOnly", true);
        response.put("time", Instant.now().toString());
        response.put("heads", state.heads());
        response.put("machine", state.machine());
        return response;
    }

    private MachineProfileStore.MachineProfile saveProfile(JsonObject body) {
        JsonObject head1 = requiredObject(body, "head1");
        JsonObject head2 = requiredObject(body, "head2");
        return profiles.save(
            optionalString(body, "id", null),
            requiredString(body, "name"),
            new MachineProfileStore.HeadConnection(
                optionalString(head1, "port", ""),
                optionalInt(head1, "baudRate", 115200)
            ),
            new MachineProfileStore.HeadConnection(
                optionalString(head2, "port", ""),
                optionalInt(head2, "baudRate", 115200)
            ),
            optionalObject(body, "head1Setup"),
            optionalObject(body, "head2Setup")
        );
    }

    private Map<String, Object> controllerState() {
        ControllerRegistry.AgentState state = controllers.state();
        return Map.of("heads", state.heads(), "machine", state.machine());
    }

    private void streamEvents(HttpExchange exchange) throws IOException {
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "text/event-stream; charset=utf-8");
        headers.set("Cache-Control", "no-cache, no-transform");
        headers.set("Connection", "keep-alive");
        exchange.sendResponseHeaders(200, 0);
        OutputStream output = exchange.getResponseBody();
        events.subscribe(output);
        events.publish("agent.ready", null, "Live machine telemetry connected", "info", controllerState());
        try {
            while (!Thread.currentThread().isInterrupted()) {
                events.keepAlive(output, Instant.now());
                Thread.sleep(15_000);
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } finally {
            events.unsubscribe(output);
            exchange.close();
        }
    }

    private boolean authorized(HttpExchange exchange) {
        String supplied = exchange.getRequestHeaders().getFirst("Authorization");
        if (supplied != null && supplied.startsWith("Bearer ")) supplied = supplied.substring(7);
        if (supplied == null || supplied.isBlank()) supplied = queryParams(exchange.getRequestURI()).get("token");
        if (supplied == null) return false;
        return MessageDigest.isEqual(
            config.token().getBytes(StandardCharsets.UTF_8),
            supplied.getBytes(StandardCharsets.UTF_8)
        );
    }

    private boolean originAllowed(String origin) {
        if (origin == null || origin.isBlank()) return true; // curl/local diagnostic use
        try {
            URI uri = URI.create(origin);
            String host = uri.getHost();
            if (host == null) return false;
            String lowerHost = host.toLowerCase();
            return config.allowedOriginSuffixes().stream().anyMatch(suffix ->
                lowerHost.equals(suffix) || lowerHost.endsWith(suffix)
            );
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private void addCorsHeaders(Headers headers, String origin) {
        if (origin != null && !origin.isBlank()) {
            headers.set("Access-Control-Allow-Origin", origin);
            headers.set("Vary", "Origin");
        }
        headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
        headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }

    private String removeApiPrefix(String path) {
        if (path.startsWith("/api/v1")) {
            String remainder = path.substring("/api/v1".length());
            return remainder.isBlank() ? "/" : remainder;
        }
        return path;
    }

    private JsonObject readJson(HttpExchange exchange) throws IOException {
        byte[] bytes = readBody(exchange, MAX_JSON_BODY_BYTES);
        if (bytes.length == 0) return new JsonObject();
        JsonElement json = gson.fromJson(new String(bytes, StandardCharsets.UTF_8), JsonElement.class);
        if (json == null || !json.isJsonObject()) throw new IllegalArgumentException("Expected a JSON object.");
        return json.getAsJsonObject();
    }

    private byte[] readBody(HttpExchange exchange, int limit) throws IOException {
        try (var input = exchange.getRequestBody(); var output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > limit) throw new IllegalArgumentException("Request body is too large.");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private void respond(HttpExchange exchange, int status, Object response) throws IOException {
        byte[] bytes = gson.toJson(response).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }

    private String requiredString(JsonObject body, String key) {
        String value = optionalString(body, key, null);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(key + " is required.");
        return value;
    }

    private String optionalString(JsonObject body, String key, String fallback) {
        JsonElement value = body.get(key);
        return value == null || value.isJsonNull() ? fallback : value.getAsString();
    }

    private JsonObject requiredObject(JsonObject body, String key) {
        JsonElement value = body.get(key);
        if (value == null || !value.isJsonObject()) {
            throw new IllegalArgumentException(key + " must be an object.");
        }
        return value.getAsJsonObject();
    }

    private JsonObject optionalObject(JsonObject body, String key) {
        JsonElement value = body.get(key);
        return value == null || value.isJsonNull() ? null : value.isJsonObject() ? value.getAsJsonObject() : null;
    }

    private int optionalInt(JsonObject body, String key, int fallback) {
        JsonElement value = body.get(key);
        return value == null || value.isJsonNull() ? fallback : value.getAsInt();
    }

    private double optionalDouble(JsonObject body, String key, double fallback) {
        JsonElement value = body.get(key);
        return value == null || value.isJsonNull() ? fallback : value.getAsDouble();
    }

    private Double optionalNullableDouble(JsonObject body, String key) {
        JsonElement value = body.get(key);
        return value == null || value.isJsonNull() ? null : value.getAsDouble();
    }

    private Map<String, String> requiredSettings(JsonObject body) {
        JsonObject settings = requiredObject(body, "settings");
        Map<String, String> values = new LinkedHashMap<>();
        for (var entry : settings.entrySet()) {
            if (!entry.getValue().isJsonPrimitive()) {
                throw new IllegalArgumentException("Each GRBL setting value must be a primitive.");
            }
            values.put(entry.getKey(), entry.getValue().getAsString());
        }
        if (values.isEmpty()) throw new IllegalArgumentException("At least one GRBL setting is required.");
        return values;
    }

    private Map<String, String> validatedSetupSettings(Map<String, String> settings) {
        Map<String, String> validated = new LinkedHashMap<>();
        for (var entry : settings.entrySet()) {
            String key = entry.getKey();
            double value;
            try {
                value = Double.parseDouble(entry.getValue());
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("Setup settings must be finite numeric values.");
            }
            if (!Double.isFinite(value)) throw new IllegalArgumentException("Setup settings must be finite numeric values.");

            boolean valid = switch (key) {
                case "$3", "$23" -> wholeNumberInRange(value, 0, 7);
                case "$5", "$20", "$21", "$22" -> wholeNumberInRange(value, 0, 1);
                case "$24", "$25" -> value > 0 && value <= 100_000;
                case "$27" -> value > 0 && value <= 10_000;
                case "$100", "$101", "$102" -> value > 0 && value <= 100_000;
                case "$130", "$131", "$132" -> value > 0 && value <= 100_000;
                default -> false;
            };
            if (!valid) throw new IllegalArgumentException("Unsupported or out-of-range machine setup setting: " + key);
            validated.put(key, entry.getValue().trim());
        }
        return validated;
    }

    private boolean wholeNumberInRange(double value, int min, int max) {
        return value == Math.rint(value) && value >= min && value <= max;
    }

    private double requiredPositiveDouble(JsonObject body, String key) {
        double value = optionalDouble(body, key, 0);
        if (value <= 0 || Double.isInfinite(value) || Double.isNaN(value)) {
            throw new IllegalArgumentException(key + " must be a positive number.");
        }
        return value;
    }

    private void requireConfirmation(JsonObject body, String action) {
        JsonElement confirmed = body.get("confirm");
        if (confirmed == null || !confirmed.isJsonPrimitive() || !confirmed.getAsBoolean()) {
            throw new IllegalArgumentException(action + " requires confirm: true. No machine action was sent.");
        }
    }

    private String validCommand(String command) {
        if (command.contains("\n") || command.contains("\r") || command.length() > 256) {
            throw new IllegalArgumentException("Console accepts one command of at most 256 characters.");
        }
        return command.trim();
    }

    private String validGcode(String gcode) {
        if (gcode.isBlank()) throw new IllegalArgumentException("gcode cannot be empty.");
        if (gcode.length() > 10 * 1024 * 1024) throw new IllegalArgumentException("gcode is limited to 10 MB.");
        return gcode;
    }

    private Map<String, String> queryParams(URI uri) {
        Map<String, String> params = new LinkedHashMap<>();
        String query = uri.getRawQuery();
        if (query == null || query.isBlank()) return params;
        for (String pair : query.split("&")) {
            String[] item = pair.split("=", 2);
            String key = URLDecoder.decode(item[0], StandardCharsets.UTF_8);
            String value = item.length > 1 ? URLDecoder.decode(item[1], StandardCharsets.UTF_8) : "";
            params.put(key, value);
        }
        return params;
    }

    private String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private record Route(String controllerId, String action) {
        static Route parse(String path) {
            String[] parts = path.split("/");
            // /heads/{1|2}/{action}, or /controllers/head-{1|2}/{action}
            if (parts.length == 4 && "heads".equals(parts[1])) {
                return new Route(parts[2], parts[3]);
            }
            if (parts.length == 4 && "controllers".equals(parts[1])) {
                return new Route(parts[2], parts[3]);
            }
            return null;
        }
    }
}
