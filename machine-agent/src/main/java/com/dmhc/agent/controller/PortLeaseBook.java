package com.dmhc.agent.controller;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/** Prevents one serial device from being controlled by both GRBL sessions. */
final class PortLeaseBook {
    private final Map<String, String> ownersByNormalizedPort = new HashMap<>();

    synchronized void acquire(String controllerId, String port) {
        String key = normalize(port);
        String owner = ownersByNormalizedPort.get(key);
        if (owner != null) {
            String detail = owner.equals(controllerId) ? "already reserved by " : "already in use by ";
            throw new IllegalStateException("Serial port " + port + " is " + detail + owner + ".");
        }
        ownersByNormalizedPort.put(key, controllerId);
    }

    synchronized void release(String controllerId, String port) {
        if (port == null || port.isBlank()) return;
        String key = normalize(port);
        if (controllerId.equals(ownersByNormalizedPort.get(key))) ownersByNormalizedPort.remove(key);
    }

    synchronized Optional<String> ownerOf(String port) {
        return Optional.ofNullable(ownersByNormalizedPort.get(normalize(port)));
    }

    private String normalize(String port) {
        return port.trim().toUpperCase();
    }
}