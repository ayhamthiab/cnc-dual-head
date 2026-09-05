package com.dmhc.agent.config;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Deliberately binds only to loopback. A token is required for all endpoints
 * that read serial devices or control a controller.
 */
public record AgentConfig(String host, int port, String token, Set<String> allowedOriginSuffixes) {
    private static final int DEFAULT_PORT = 18888;

    public static AgentConfig from(String[] args) {
        String host = "127.0.0.1";
        int port = DEFAULT_PORT;
        String token = System.getenv("DMHC_AGENT_TOKEN");

        for (int index = 0; index < args.length; index++) {
            String arg = args[index];
            if ("--port".equals(arg) && index + 1 < args.length) {
                port = parsePort(args[++index]);
            } else if ("--token".equals(arg) && index + 1 < args.length) {
                token = args[++index].trim();
            } else if ("--host".equals(arg) && index + 1 < args.length) {
                host = args[++index].trim();
            }
        }

        if (!"127.0.0.1".equals(host) && !"localhost".equals(host)) {
            throw new IllegalArgumentException(
                "The agent only accepts 127.0.0.1 or localhost. It must never bind publicly."
            );
        }
        if (token == null || token.isBlank()) {
            byte[] bytes = new byte[24];
            new SecureRandom().nextBytes(bytes);
            token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        }

        Set<String> allowedOrigins = new LinkedHashSet<>();
        String configuredOrigins = System.getenv("DMHC_ALLOWED_ORIGIN_SUFFIXES");
        if (configuredOrigins != null && !configuredOrigins.isBlank()) {
            for (String origin : configuredOrigins.split(",")) {
                if (!origin.isBlank()) allowedOrigins.add(origin.trim().toLowerCase());
            }
        }
        if (allowedOrigins.isEmpty()) {
            allowedOrigins.add(".replit.dev");
            allowedOrigins.add(".replit.app");
            allowedOrigins.add("localhost");
            allowedOrigins.add("127.0.0.1");
        }
        return new AgentConfig(host, port, token, Set.copyOf(allowedOrigins));
    }

    private static int parsePort(String candidate) {
        try {
            int port = Integer.parseInt(candidate);
            if (port < 1024 || port > 65535) throw new NumberFormatException();
            return port;
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Agent port must be an integer between 1024 and 65535.");
        }
    }
}