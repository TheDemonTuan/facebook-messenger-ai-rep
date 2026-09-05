import { describe, it, expect } from "vitest";

describe("Full E2E Multi-Turn & Fairness Simulation", () => {
  it("maintains single agent invariant and fairness yielding under multi-customer load", async () => {
    // Simulated state store
    interface SimQueueItem {
      id: string;
      conversationId: string;
      customerName: string;
      inboundVersion: number;
      readyAt: number;
      stickyTurns: number;
      continuationEligibleUntil: number | null;
      yieldRequired: boolean;
      claimToken: string | null;
    }

    const queue: SimQueueItem[] = [];
    let activeClaim: string | null = null;
    let now = 1000;

    // Helper to simulate inbound arrival
    const simulateInbound = (convId: string, customer: string) => {
      const existing = queue.find((q) => q.conversationId === convId);
      if (existing) {
        existing.inboundVersion++;
        existing.readyAt = now + 3000; // 3s debounce reset
      } else {
        queue.push({
          id: `queue-${convId}`,
          conversationId: convId,
          customerName: customer,
          inboundVersion: 1,
          readyAt: now + 3000,
          stickyTurns: 0,
          continuationEligibleUntil: null,
          yieldRequired: false,
          claimToken: null,
        });
      }
    };

    // Helper simulating single-agent scheduler claim
    const claimNext = () => {
      if (activeClaim !== null) return null; // Invariant: max 1 claimed conversation

      const readyCandidates = queue.filter((q) => q.readyAt <= now);
      if (readyCandidates.length === 0) return null;

      // Check sticky candidate. If it already consumed the allowed turns while another
      // customer is ready, force it to yield before choosing any sticky work.
      const stickyCandidate = readyCandidates.find(
        (q) =>
          q.continuationEligibleUntil &&
          q.continuationEligibleUntil > now &&
          !q.yieldRequired
      );

      let target = stickyCandidate;
      if (readyCandidates.length > 1 && stickyCandidate && stickyCandidate.stickyTurns >= 3) {
        stickyCandidate.yieldRequired = true;
        stickyCandidate.continuationEligibleUntil = null;
        target = undefined;
      }

      if (target && target.stickyTurns >= 3) {
        target = undefined;
      }

      // If no sticky candidate, take earliest readyAt (FIFO)
      if (!target) {
        target = readyCandidates.sort((a, b) => a.readyAt - b.readyAt)[0];
      }

      if (target) {
        target.claimToken = `token-${now}`;
        target.stickyTurns++;
        activeClaim = target.conversationId;
      }

      return target;
    };

    // Helper simulating turn completion & release
    const release = (convId: string, keepSticky = true) => {
      const item = queue.find((q) => q.conversationId === convId);
      if (item) {
        item.claimToken = null;
        if (keepSticky && item.stickyTurns < 3) {
          item.continuationEligibleUntil = now + 45000; // 45s sticky window
        } else {
          item.continuationEligibleUntil = null;
          item.yieldRequired = true;
        }
      }
      activeClaim = null;
    };

    // 1. Customer A sends 3 messages in rapid succession
    simulateInbound("conv-A", "Customer A");
    now += 500;
    simulateInbound("conv-A", "Customer A");
    now += 500;
    simulateInbound("conv-A", "Customer A");

    // Check version bumped to 3 and debounce delayed
    const itemA = queue.find((q) => q.conversationId === "conv-A");
    expect(itemA?.inboundVersion).toBe(3);
    expect(itemA?.readyAt).toBe(2000 + 3000);

    // Advance clock past debounce
    now = 6000;

    // 2. Scheduler claims Customer A
    const claim1 = claimNext();
    expect(claim1?.conversationId).toBe("conv-A");
    expect(activeClaim).toBe("conv-A");

    // Concurrently attempting to claim another should return null (Single-Agent invariant)
    expect(claimNext()).toBeNull();

    // 3. Complete turn 1 for Customer A
    now += 5000;
    release("conv-A", true);
    expect(activeClaim).toBeNull();
    expect(itemA?.stickyTurns).toBe(1);
    expect(itemA?.continuationEligibleUntil).toBe(now + 45000);

    // 4. Customer B arrives while Customer A is in sticky window
    simulateInbound("conv-B", "Customer B");
    now += 4000; // Pass debounce for B
    queue.find((q) => q.conversationId === "conv-B")!.readyAt = now;

    // Customer A also replies within sticky window!
    simulateInbound("conv-A", "Customer A");
    queue.find((q) => q.conversationId === "conv-A")!.readyAt = now;

    // 5. Next dispatch: Customer A should be prioritized because sticky window is open (Turn 2)
    const claim2 = claimNext();
    expect(claim2?.conversationId).toBe("conv-A");
    expect(claim2?.stickyTurns).toBe(2);

    // Complete Turn 2
    release("conv-A", true);

    // 6. Customer A replies again (Turn 3)
    simulateInbound("conv-A", "Customer A");
    queue.find((q) => q.conversationId === "conv-A")!.readyAt = now;

    const claim3 = claimNext();
    expect(claim3?.conversationId).toBe("conv-A");
    expect(claim3?.stickyTurns).toBe(3);

    // Complete Turn 3 -> max turns reached!
    release("conv-A", true);

    // 7. Customer A replies again, BUT Customer B is still waiting:
    simulateInbound("conv-A", "Customer A");
    // A's new inbound begins its debounce window; B was already ready first.
    // The next dispatch must serve the waiting customer rather than preserve A's sticky turn.

    // Scheduler MUST YIELD to Customer B!
    const claim4 = claimNext();
    expect(claim4?.conversationId).toBe("conv-B");
    expect(claim4?.customerName).toBe("Customer B");
  });
});
