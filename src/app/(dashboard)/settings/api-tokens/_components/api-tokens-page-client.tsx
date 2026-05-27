"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/ui/empty-state";
import { Banner } from "@/components/ui/banner";
import { TokenTable, type TokenRow } from "./token-table";
import { GenerateTokenDialog } from "./generate-token-dialog";
import { TokenRevealModal } from "./token-reveal-modal";
import { RegenerateConfirm } from "./regenerate-confirm";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export interface OrgOption {
  id: string;
  name: string;
}

export interface ApiTokensPageClientProps {
  tokens: TokenRow[];
  orgs: OrgOption[];
  orgNames: Record<string, string>;
  creatorNames: Record<string, string>;
  callerRole: "super_admin" | "org_manager";
}

type Feedback = { tone: "success" | "info"; message: string };

/**
 * Client shell for /settings/api-tokens (#256). Holds the dialog state
 * for Generate, Reveal, Revoke, and Regenerate. Plaintext tokens live
 * ONLY in `revealedPlaintext` for the lifetime of the modal — closing
 * the modal clears the state. There is no persistence and no display
 * surface other than the modal.
 */
export function ApiTokensPageClient(props: ApiTokensPageClientProps) {
  const router = useRouter();

  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [revokeTarget, setRevokeTarget] = React.useState<TokenRow | null>(null);
  const [regenerateTarget, setRegenerateTarget] =
    React.useState<TokenRow | null>(null);
  const [revealedPlaintext, setRevealedPlaintext] = React.useState<
    string | null
  >(null);
  const [feedback, setFeedback] = React.useState<Feedback | null>(null);

  // Plaintext is wiped from React state when the modal closes. We also
  // null it out on page-leave / unmount as defense-in-depth.
  React.useEffect(() => {
    return () => {
      setRevealedPlaintext(null);
    };
  }, []);

  async function handleGenerated(plaintext: string, message: string) {
    setRevealedPlaintext(plaintext);
    setFeedback({ tone: "success", message });
    router.refresh();
  }

  async function handleRevokeConfirm(): Promise<void> {
    if (!revokeTarget) return;
    const res = await fetch(`/api/org-api-tokens/${revokeTarget.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Failed to revoke token.");
    }
    setFeedback({
      tone: "success",
      message: `Token "${revokeTarget.name}" revoked.`,
    });
    setRevokeTarget(null);
    router.refresh();
  }

  async function handleRegenerateConfirm(): Promise<void> {
    if (!regenerateTarget) return;
    const res = await fetch(
      `/api/org-api-tokens/${regenerateTarget.id}/regenerate`,
      { method: "POST" }
    );
    const body = (await res.json().catch(() => ({}))) as {
      plaintext?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? "Failed to regenerate token.");
    }
    if (body.plaintext) {
      setRevealedPlaintext(body.plaintext);
    }
    setFeedback({
      tone: "success",
      message: `Token "${regenerateTarget.name}" regenerated. The new token is shown above — copy it now.`,
    });
    setRegenerateTarget(null);
    router.refresh();
  }

  const hasTokens = props.tokens.length > 0;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            API tokens
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Per-organisation credentials for the customerapp integration.
            Tokens are shown once at creation time and cannot be retrieved
            again — store the plaintext immediately.
          </p>
        </div>
        {hasTokens && (
          <button
            type="button"
            onClick={() => setGenerateOpen(true)}
            className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Generate token
          </button>
        )}
      </div>

      {feedback && (
        <Banner
          tone={feedback.tone === "success" ? "success" : "info"}
          title={feedback.tone === "success" ? "Success" : "Note"}
          action={
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-xs font-medium underline hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Dismiss
            </button>
          }
        >
          {feedback.message}
        </Banner>
      )}

      {hasTokens ? (
        <TokenTable
          rows={props.tokens}
          orgNames={props.orgNames}
          creatorNames={props.creatorNames}
          callerRole={props.callerRole}
          onRevoke={setRevokeTarget}
          onRegenerate={setRegenerateTarget}
        />
      ) : (
        <EmptyState
          eyebrow="API tokens"
          title="Generate the first token"
          body={
            <>
              Each token authenticates one customerapp instance. Give the
              token a recognisable name (e.g. the deployment URL or env)
              so you can identify it later in the audit log.
            </>
          }
          cta={
            <button
              type="button"
              onClick={() => setGenerateOpen(true)}
              className="inline-flex h-9 items-center rounded-md border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Generate token
            </button>
          }
          footnote="The plaintext is shown only once. Treat each token like a password."
        />
      )}

      <GenerateTokenDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        orgs={props.orgs}
        callerRole={props.callerRole}
        onGenerated={handleGenerated}
      />

      <TokenRevealModal
        open={revealedPlaintext !== null}
        plaintext={revealedPlaintext}
        onOpenChange={(open) => {
          if (!open) setRevealedPlaintext(null);
        }}
      />

      {/* Revoke confirm */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        tone="destructive"
        title={
          revokeTarget
            ? `Revoke "${revokeTarget.name}"?`
            : "Revoke token"
        }
        description={
          "Any customerapp instance still using this token will get 401 errors on its next request. This cannot be undone."
        }
        confirmLabel="Revoke token"
        onConfirm={handleRevokeConfirm}
      />

      {/* Regenerate confirm — wraps ConfirmDialog with the hard-cutover copy */}
      <RegenerateConfirm
        open={regenerateTarget !== null}
        tokenName={regenerateTarget?.name ?? ""}
        onOpenChange={(open) => {
          if (!open) setRegenerateTarget(null);
        }}
        onConfirm={handleRegenerateConfirm}
      />
    </div>
  );
}
