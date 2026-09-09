import type { OutboundActionItem } from "../types";

export type TakeoverState = "AUTO" | "WAITING_CANCEL_ACK" | "MANUAL_ACTIVE" | "RESUMING";

export interface TakeoverMachineContext {
  state: TakeoverState;
  manualMode: boolean;
  cancelAckReceived: boolean;
  activeActionId?: string | null;
}

/**
 * Creates the initial takeover context based on conversation manualMode and replyControlMode.
 */
export function createTakeoverContext(manualMode: boolean, replyControlMode?: string | null): TakeoverMachineContext {
  const isHuman = manualMode || (Boolean(replyControlMode) && replyControlMode !== "AUTO");
  return {
    state: isHuman ? "MANUAL_ACTIVE" : "AUTO",
    manualMode: isHuman,
    cancelAckReceived: isHuman,
  };
}

/**
 * Returns true if takeover can be initiated (must be in AUTO mode).
 */
export function canInitiateTakeover(context: TakeoverMachineContext): boolean {
  return context.state === "AUTO";
}

/**
 * Transition from AUTO -> WAITING_CANCEL_ACK upon operator clicking takeover.
 */
export function transitionToWaitingCancelAck(context: TakeoverMachineContext): TakeoverMachineContext {
  if (context.state !== "AUTO") {
    return context;
  }
  return {
    ...context,
    state: "WAITING_CANCEL_ACK",
    cancelAckReceived: false,
  };
}

/**
 * Transition to MANUAL_ACTIVE once cancel acknowledgement is confirmed.
 * Checks that no outbound actions remain in active TYPING or PENDING status.
 */
export function transitionToManualActive(
  context: TakeoverMachineContext,
  options?: { actions?: OutboundActionItem[]; replyControlMode?: string | null }
): TakeoverMachineContext {
  if (context.state !== "WAITING_CANCEL_ACK" && context.state !== "AUTO") {
    return context;
  }

  // The API confirms the ownership change, not that an in-flight browser send stopped.
  // Keep the composer locked until no non-terminal AI action remains.
  if (options?.actions) {
    const hasActiveAiAction = options.actions.some(
      (action) =>
        action.actor === "AI" &&
        ["PENDING", "TYPING", "SENDING", "SEND_INTENT", "RETRY_APPROVED"].includes(action.status)
    );
    if (hasActiveAiAction) {
      return {
        ...context,
        state: "WAITING_CANCEL_ACK",
        cancelAckReceived: false,
      };
    }
  }

  return {
    ...context,
    state: "MANUAL_ACTIVE",
    manualMode: true,
    cancelAckReceived: true,
  };
}

/**
 * Operator can only type and submit manual messages when in MANUAL_ACTIVE state.
 */
export function canSendManualMessage(context: TakeoverMachineContext): boolean {
  return context.state === "MANUAL_ACTIVE" && context.cancelAckReceived;
}

/**
 * Transition to RESUMING when operator clicks Resume AI.
 */
export function transitionToResuming(context: TakeoverMachineContext): TakeoverMachineContext {
  if (context.state !== "MANUAL_ACTIVE") {
    return context;
  }
  return {
    ...context,
    state: "RESUMING",
  };
}

/**
 * Complete resume back to AUTO mode.
 */
export function transitionToAuto(context: TakeoverMachineContext): TakeoverMachineContext {
  // A refetch started before takeover can return AUTO after the operator has
  // already clicked. Only an explicit resume may leave the pending state.
  if (context.state === "WAITING_CANCEL_ACK") {
    return context;
  }
  return {
    ...context,
    state: "AUTO",
    manualMode: false,
    cancelAckReceived: false,
    activeActionId: null,
  };
}
