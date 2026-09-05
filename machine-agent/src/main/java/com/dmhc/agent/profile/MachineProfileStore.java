package com.dmhc.agent.profile;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;
import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/**
 * Local, small-machine profile store. It intentionally never persists the
 * agent token, G-code programs, controller status, or serial credentials.
 */
public final class MachineProfileStore {
    private static final Type PROFILE_LIST = new TypeToken<List<MachineProfile>>() {}.getType();
    private final Path file;
    private final Gson gson = new Gson();

    public MachineProfileStore(Path file) {
        this.file = file;
    }

    public synchronized List<MachineProfile> list() {
        List<MachineProfile> profiles = read();
        profiles.sort(Comparator.comparing(MachineProfile::updatedAt).reversed());
        return profiles;
    }

    public synchronized MachineProfile save(
        String id,
        String name,
        HeadConnection head1,
        HeadConnection head2
    ) {
        return save(id, name, head1, head2, null, null);
    }

    public synchronized MachineProfile save(
        String id,
        String name,
        HeadConnection head1,
        HeadConnection head2,
        JsonObject head1Setup,
        JsonObject head2Setup
    ) {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("Profile name is required.");
        validateHead(head1);
        validateHead(head2);

        List<MachineProfile> profiles = read();
        String now = Instant.now().toString();
        int existingIndex = -1;
        if (id != null && !id.isBlank()) {
            for (int index = 0; index < profiles.size(); index++) {
                if (profiles.get(index).id().equals(id)) {
                    existingIndex = index;
                    break;
                }
            }
        }
        MachineProfile profile;
        if (existingIndex >= 0) {
            MachineProfile previous = profiles.get(existingIndex);
            profile = new MachineProfile(
                previous.id(), name.trim(), head1, head2,
                head1Setup == null ? previous.head1Setup() : head1Setup,
                head2Setup == null ? previous.head2Setup() : head2Setup,
                previous.createdAt(), now
            );
            profiles.set(existingIndex, profile);
        } else {
            profile = new MachineProfile(
                UUID.randomUUID().toString(), name.trim(), head1, head2,
                head1Setup, head2Setup, now, now
            );
            profiles.add(profile);
        }
        write(profiles);
        return profile;
    }

    public synchronized void delete(String id) {
        List<MachineProfile> profiles = read();
        boolean removed = profiles.removeIf(profile -> profile.id().equals(id));
        if (!removed) throw new IllegalArgumentException("Profile was not found.");
        write(profiles);
    }

    private void validateHead(HeadConnection head) {
        if (head == null) throw new IllegalArgumentException("Both head settings are required.");
        if (head.baudRate() < 1200 || head.baudRate() > 2_000_000) {
            throw new IllegalArgumentException("Profile baud rate must be between 1200 and 2000000.");
        }
    }

    private List<MachineProfile> read() {
        if (!Files.exists(file)) return new ArrayList<>();
        try {
            String content = Files.readString(file, StandardCharsets.UTF_8);
            List<MachineProfile> loaded = gson.fromJson(content, PROFILE_LIST);
            return loaded == null ? new ArrayList<>() : new ArrayList<>(loaded);
        } catch (IOException | RuntimeException error) {
            throw new IllegalStateException("Cannot read local machine profiles: " + error.getMessage());
        }
    }

    private void write(List<MachineProfile> profiles) {
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, gson.toJson(profiles), StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new IllegalStateException("Cannot save local machine profiles: " + error.getMessage());
        }
    }

    public record MachineProfile(
        String id,
        String name,
        HeadConnection head1,
        HeadConnection head2,
        JsonObject head1Setup,
        JsonObject head2Setup,
        String createdAt,
        String updatedAt
    ) {}

    public record HeadConnection(String port, int baudRate) {
        public HeadConnection {
            port = port == null ? "" : port.trim();
        }
    }
}