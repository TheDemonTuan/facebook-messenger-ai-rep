import type { OutboundActionItem } from "../types";

export type TakeoverState = "AUTO" | "WAITING_CANCEL_ACK" | "MANUAL_ACTIVE" | "RESUMING";

export interface TakeoverMachineContext {
  state: TakeoverState;
  manualMode: boolean;
  cancelAckReceived: boolean;
  activeActionId?: string | null;
}

/**
 * Creates the initial takeover context based on conversation manualMode.
 */
export function createTakeoverContext(manualMode: boolean): TakeoverMachineContext {
  return {
    state: manualMode ? "MANUAL_ACTIVE" : "AUTO",
    manualMode,
    cancelAckReceived: manualMode,
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
  options?: { actions?: OutboundActionItem[]; forceAck?: boolean }
): TakeoverMachineContext {
  if (context.state !== "WAITING_CANCEL_ACK" && context.state !== "AUTO") {
    return context;
  }

  // If actions are provided and any is still TYPING, cancel ack is NOT ready unless forceAck is set
  if (options?.actions && !options.forceAck) {
    const hasActiveTyping = options.actions.some(
      (a) => a.status === "TYPING" || a.status === "SENDING"
    );
    if (hasActiveTyping) {
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
  return {
    ...context,
    state: "AUTO",
    manualMode: false,
    cancelAckReceived: false,
    activeActionId: null,
  };
}
