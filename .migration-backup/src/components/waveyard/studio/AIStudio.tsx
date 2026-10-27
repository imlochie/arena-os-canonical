"use client";

/**
 * AI studio — REQUEST → ANALYSIS → PROPOSAL → REVIEW → ACCEPT/REJECT.
 *
 * The capability banner uses the exact honest labels from the capability
 * model (the model receives the measured analysis packet, never raw
 * audio). Proposals are shown as exact per-channel diffs with the
 * validator's clamps; ACCEPT re-validates server-side and persists to the
 * remix session; REJECT discards. An unavailable provider shows its
 * reason — there is no canned fallback, and nothing else in the studio
 * stops working.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type ProviderStatus =
  | { state: "available"; providerId: string; model: string; baseUrl: string }
  | { state: "unavailable"; providerId: string; reason: string };

type Workflow = {
  id: string;
  label: string;
  description: string;
  expectation: "analysis" | "proposal";
};

type ProposalChange = {
  channelId: string;
  channelName: string;
  processor: string;
  parameters: Record<string, number>;
  reason: string;
};

type ClampRecord = { channelId: string; parameter: string; from: number; to: number };

type RequestResult =
  | { kind: "analysis"; text: string; model: string; capabilityDetail: string }
  | {
      kind: "proposal";
      rationale: string;
      applied: ProposalChange[];
      clamped: ClampRecord[];
      model: string;
    }
  | { kind: "rejected"; errors: string[]; rawModelOutput: string }
  | { kind: "unavailable"; reason: string };

export function AIStudio({ projectId }: { projectId: string }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string>("openai");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [capabilityLabels, setCapabilityLabels] = useState<Record<string, string>>({});
  const [providerId, setProviderId] = useState<string>("");
  const [workflowId, setWorkflowId] = useState<string>("");
  const [phase, setPhase] = useState<"idle" | "loading" | "applying">("idle");
  const [result, setResult] = useState<RequestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/waveyard/projects/${projectId}/ai`, { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data === null) return;
        setProviders(data.providers ?? []);
        setDefaultProviderId(data.defaultProviderId ?? "openai");
        setProviderId((current) => current || data.defaultProviderId || "openai");
        setWorkflows(data.workflows ?? []);
        setWorkflowId((current) => current || (data.workflows?.[0]?.id ?? ""));
        setCapabilityLabels(data.capabilityLabels ?? {});
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [projectId]);

  const request = useCallback(async () => {
    setError(null);
    setResult(null);
    setPhase("loading");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const response = await fetch(`/api/waveyard/projects/${projectId}/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "request", workflowId, providerId: providerId || defaultProviderId }),
      signal: controller.signal,
    }).catch(() => null);
    if (response === null) {
      setPhase("idle");
      setError("Network request failed.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    setPhase("idle");
    if (response.status === 503) {
      setResult({ kind: "unavailable", reason: String(data.error ?? "Provider unavailable.") });
      return;
    }
    if (!response.ok) {
      setError(String(data.error ?? "AI request failed."));
      return;
    }
    if (data.rejected !== undefined) {
      setResult({ kind: "rejected", errors: data.rejected, rawModelOutput: data.rawModelOutput ?? "" });
      return;
    }
    if (data.proposal !== undefined) {
      setResult({
        kind: "proposal",
        rationale: data.proposal.rationale ?? "",
        applied: data.proposal.applied ?? [],
        clamped: data.proposal.clamped ?? [],
        model: data.model,
      });
      return;
    }
    setResult({
      kind: "analysis",
      text: String(data.analysis ?? ""),
      model: String(data.model ?? ""),
      capabilityDetail: String(data.capabilityDetail ?? ""),
    });
  }, [projectId, workflowId, providerId, defaultProviderId]);

  const accept = useCallback(async () => {
    if (result === null || result.kind !== "proposal") return;
    setError(null);
    setPhase("applying");
    // ACCEPT sends the proposal back through the server-side validator —
    // the UI is never the authority.
    const proposalPayload = {
      rationale: result.rationale || "AI proposal",
      changes: result.applied.map((change) => ({
        targetChannelId: change.channelId,
        processor: change.processor,
        parameters: change.parameters,
        reason: change.reason,
      })),
    };
    const response = await fetch(`/api/waveyard/projects/${projectId}/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "apply", workflowId, proposal: proposalPayload }),
    }).catch(() => null);
    setPhase("idle");
    if (response === null) {
      setError("Network request failed.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(String(data.error ?? "Apply failed.") + (Array.isArray(data.errors) ? " " + data.errors.join("; ") : ""));
      return;
    }
    setResult({ kind: "analysis", text: `Applied ${data.applied.length} change(s) to the remix session — inserts applied by the AI are badged · AI in the mixer's FX racks. Play to audition; the mixer's undo history reverts.`, model: result.model, capabilityDetail: "" });
  }, [projectId, result, workflowId]);

  const selectedWorkflow = workflows.find((workflow) => workflow.id === workflowId);
  const selectedProvider = providers.find((provider) => provider.providerId === (providerId || defaultProviderId));

  return (
    <section className="ai-studio" aria-label="AI assist">
      <header>
        <h3>AI</h3>
        <p className="muted">{capabilityLabels["audio-derived"] ?? "AI reasoning: derived audio analysis"}</p>
      </header>

      <ol className="workflow-stages" aria-label="AI workflow stages">
        <li className={result === null ? "current" : "done"}>1 · Request</li>
        <li className={result !== null ? "current" : ""}>2 · Analysis / Proposal</li>
        <li className={result?.kind === "proposal" ? "current" : ""}>3 · Review</li>
        <li className={phase === "applying" ? "current" : ""}>4 · Apply</li>
      </ol>

      <div className="ai-controls">
        <label>
          Workflow
          <select value={workflowId} onChange={(event) => { setWorkflowId(event.target.value); setResult(null); }}>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.label} {workflow.expectation === "analysis" ? "(analysis)" : "(proposal)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select value={providerId || defaultProviderId} onChange={(event) => setProviderId(event.target.value)}>
            {providers.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.providerId} {provider.state === "available" ? `(${provider.model})` : "— not configured"}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={request}
          disabled={phase !== "idle" || workflowId === ""}
        >
          {phase === "loading" ? "Working…" : "Request"}
        </button>
      </div>
      {selectedWorkflow !== undefined && <p className="muted ai-workflow-desc">{selectedWorkflow.description}</p>}
      {selectedProvider !== undefined && selectedProvider.state === "unavailable" && (
        <p className="error-message" role="status">{selectedProvider.reason}</p>
      )}

      {error !== null && <p className="error-message" role="alert">{error}</p>}

      {result !== null && result.kind === "unavailable" && (
        <div className="ai-result ai-unavailable" data-testid="ai-unavailable">
          <h4>Provider unavailable</h4>
          <p>{result.reason}</p>
          <p className="muted">No fallback content was generated. Every non-AI feature keeps working.</p>
        </div>
      )}

      {result !== null && result.kind === "rejected" && (
        <div className="ai-result ai-rejected" data-testid="ai-rejected">
          <h4>Proposal rejected by the validator</h4>
          <ul>{result.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>
          <p className="muted">The model output did not satisfy the contract. Nothing was applied.</p>
          <details>
            <summary>Raw model output</summary>
            <pre>{result.rawModelOutput}</pre>
          </details>
        </div>
      )}

      {result !== null && result.kind === "analysis" && (
        <div className="ai-result" data-testid="ai-analysis">
          {result.capabilityDetail !== "" && <p className="muted">{result.capabilityDetail}</p>}
          <pre className="ai-analysis-text">{result.text}</pre>
        </div>
      )}

      {result !== null && result.kind === "proposal" && (
        <div className="ai-result ai-proposal" data-testid="ai-proposal">
          <h4><span className="stage-chip recommended">Review</span> Exactly what the AI wants to change — channel by channel</h4>
          <p>{result.rationale}</p>
          <table className="cleanup-measurements">
            <thead>
              <tr><th>Channel</th><th>Processor</th><th>Parameters</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {result.applied.map((change, index) => (
                <tr key={index}>
                  <td>{change.channelName}</td>
                  <td>{change.processor}</td>
                  <td>{Object.entries(change.parameters).map(([key, value]) => `${key}=${value}`).join(", ")}</td>
                  <td>{change.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.clamped.length > 0 && (
            <p className="muted">
              Validator clamps: {result.clamped.map((clamp) => `${clamp.parameter} ${clamp.from} → ${clamp.to}`).join("; ")}
            </p>
          )}
          <div className="cleanup-actions">
            <button onClick={accept} disabled={phase === "applying"}>
              {phase === "applying" ? "Applying…" : "Apply to session (undo via mixer history)" }
            </button>
            <button onClick={() => setResult(null)}>Reject</button>
          </div>
        </div>
      )}
    </section>
  );
}
