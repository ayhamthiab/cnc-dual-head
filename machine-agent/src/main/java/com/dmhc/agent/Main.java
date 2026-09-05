package com.dmhc.agent;

import com.dmhc.agent.api.MachineHttpServer;
import com.dmhc.agent.config.AgentConfig;
import com.dmhc.agent.controller.ControllerRegistry;
import com.dmhc.agent.events.MachineEventPublisher;

/**
 * Starts the local-only bridge between the web UI and UGS Core.
 *
 * <p>No serial connection, motion, homing, jog, or stream is started here.
 * Every hardware action is exposed only through an explicit authenticated API
 * request.</p>
 */
public final class Main {
    private Main() {}

    public static void main(String[] args) throws Exception {
        System.setProperty("java.awt.headless", "true");

        AgentConfig config = AgentConfig.from(args);
        MachineEventPublisher events = new MachineEventPublisher();
        ControllerRegistry controllers = new ControllerRegistry(events);
        MachineHttpServer server = new MachineHttpServer(config, controllers, events);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("Stopping DMHC Machine Agent...");
            controllers.disconnectAll();
            server.stop();
        }, "dmhc-agent-shutdown"));

        server.start();
        System.out.printf(
            "DMHC Machine Agent listening on http://%s:%d/api/v1%n",
            config.host(), config.port()
        );
        System.out.println("Binding is local-only. Enter the printed agent token in the Machine Controller page.");
        System.out.printf("Agent token: %s%n", config.token());
    }
}