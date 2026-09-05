package com.dmhc.agent.controller;

import com.willwinder.universalgcodesender.GrblController;
import com.willwinder.universalgcodesender.GrblUtils;
import com.willwinder.universalgcodesender.listeners.MessageType;
import com.willwinder.universalgcodesender.types.GcodeCommand;

/**
 * GRBL controller with response-ownership diagnostics for one ControllerSession.
 *
 * <p>UGS normally owns the command queue. A response received after that queue
 * was cleared (for example after initialization, cancellation, or reset) must
 * never be allowed to complete a later command. GRBL responses do not carry an
 * identifier, so an orphan response is reported and discarded rather than
 * guessed.</p>
 */
final class SessionGrblController extends GrblController {
    private volatile String lastCompletedCommand = "<none>";

    @Override
    protected void rawResponseHandler(String response) {
        if (GrblUtils.isOkResponse(response) && getActiveCommand().isEmpty()) {
            String state = getControllerStatus() == null || getControllerStatus().getState() == null
                ? "UNKNOWN"
                : getControllerStatus().getState().name();
            getMessageService().dispatchMessage(
                MessageType.ERROR,
                "UGS response ownership error: ignored orphan response <" + response.trim()
                    + "> because this head has no pending command"
                    + " (state=" + state
                    + ", streaming=" + isStreaming()
                    + ", lastCompleted=" + lastCompletedCommand + "). "
                    + "The stale/late response was not assigned to another command.\n"
            );
            return;
        }
        super.rawResponseHandler(response);
    }

    @Override
    public void commandComplete() throws UnexpectedCommand {
        String completed = getActiveCommand()
            .map(GcodeCommand::getCommandString)
            .orElse("<unknown>");
        super.commandComplete();
        lastCompletedCommand = completed;
    }
}