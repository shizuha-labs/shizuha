const AI_MODELS_NAMESPACE = "ai-models";

const READ_ONLY_KUBECTL_VERBS = new Set([
  "api-resources",
  "api-versions",
  "auth",
  "cluster-info",
  "config",
  "describe",
  "diff",
  "explain",
  "get",
  "logs",
  "top",
  "version",
  "wait",
]);

const MUTATING_KUBECTL_VERBS = new Set([
  "annotate",
  "apply",
  "autoscale",
  "cordon",
  "create",
  "delete",
  "drain",
  "edit",
  "exec",
  "label",
  "patch",
  "replace",
  "rollout",
  "scale",
  "set",
  "taint",
  "uncordon",
]);

const FLAGS_WITH_VALUES = new Set([
  "-n",
  "-o",
  "-f",
  "-k",
  "-l",
  "--as",
  "--as-group",
  "--cache-dir",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--context",
  "--field-manager",
  "--field-selector",
  "--filename",
  "--kubeconfig",
  "--kustomize",
  "--label-selector",
  "--namespace",
  "--output",
  "--profile",
  "--request-timeout",
  "--selector",
  "--server",
  "--subresource",
  "--token",
  "--user",
]);

const MODEL_NAME_RE =
  /(?:^|[^a-z0-9_-])(deepseek[a-z0-9_-]*|qwen[a-z0-9_-]*|gemma[a-z0-9_-]*|vllm[a-z0-9_-]*)(?:$|[^a-z0-9_-])/i;
const PROTECTED_RESOURCE_RE =
  /\b(statefulsets?|sts|services?|svc|deployments?|deploy|pods?|endpointslices?|endpoints?)\b/i;
const SEMANTIC_KNOB_RE =
  /(?:max[-_]model[-_]len|max[-_]num[-_]seqs|max[-_]num[-_]batched[-_]tokens|gpu[-_]memory[-_]utilization|kv[-_]cache[-_]dtype|prefix[-_]caching|num[-_]speculative[-_]tokens|speculative|\bmtp\b|tensor[-_]parallel|NCCL_|NCCL\b|fabric0|fabric_ib|selector|admission|max[-_]concurrent|vllm:num_requests|capacity)/i;

const BREAK_GLASS_APPROVAL_KEYS = [
  "SHIZUHA_CORTEX_BREAK_GLASS_APPROVAL",
  "SHIZUHA_CORTEX_MODEL_SERVING_BREAK_GLASS_APPROVAL",
];
const BREAK_GLASS_REASON_KEYS = [
  "SHIZUHA_CORTEX_BREAK_GLASS_REASON",
  "SHIZUHA_CORTEX_MODEL_SERVING_BREAK_GLASS_REASON",
];
const APPROVAL_MARKER_RE =
  /^(human|operator|hritik|admin-ops|ceo|pulse|task|connect|approval)[:/#-]/i;

export type CortexKubectlGuardrailDecision =
  | { allowed: true; breakGlass?: { approval: string; reason: string } }
  | { allowed: false; message: string; reasons: string[] };

interface KubectlInvocation {
  raw: string;
  args: string[];
  verb: string | null;
  namespace: string | null;
  namespaceExpression: string | null;
  namespaceResolutionFailed: boolean;
  allNamespaces: boolean;
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }

    if (quote === "single") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === "double") {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }

    if (ch === "'") {
      quote = "single";
      continue;
    }

    if (ch === '"') {
      quote = "double";
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (ch === ";" || ch === "\n") {
      pushCurrent();
      tokens.push(";");
      continue;
    }

    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      pushCurrent();
      tokens.push(ch + next);
      i += 1;
      continue;
    }

    if (ch === "|") {
      pushCurrent();
      tokens.push("|");
      continue;
    }

    current += ch;
  }

  pushCurrent();
  return tokens;
}

function isSeparator(token: string): boolean {
  return token === ";" || token === "&&" || token === "||" || token === "|";
}

function isKubectlToken(token: string): boolean {
  return /(?:^|\/)kubectl(?:\.exe)?$/.test(token);
}

function flagConsumesValue(flag: string): boolean {
  if (flag.includes("=")) return false;
  return FLAGS_WITH_VALUES.has(flag);
}

function resolveNamespaceToken(
  token: string,
  env: NodeJS.ProcessEnv,
): { value: string | null; unresolved: boolean } {
  const variable = token.match(
    /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/,
  );
  if (variable) {
    const key = variable[1] ?? variable[2]!;
    const value = env[key];
    return value
      ? { value, unresolved: false }
      : { value: null, unresolved: true };
  }

  // Fail closed for shell expressions or mixed variables (for example
  // $(cat ns), ${TEAM}-models). The guardrail runs before bash expands them,
  // so it cannot safely prove the command avoids ai-models.
  if (token.includes("$")) return { value: null, unresolved: true };

  return { value: token, unresolved: false };
}

function extractNamespace(
  args: string[],
  env: NodeJS.ProcessEnv,
): {
  namespace: string | null;
  namespaceExpression: string | null;
  namespaceResolutionFailed: boolean;
  allNamespaces: boolean;
} {
  let namespace: string | null = null;
  let namespaceExpression: string | null = null;
  let namespaceResolutionFailed = false;
  let allNamespaces = false;

  const setNamespace = (token: string | undefined) => {
    if (!token) return;
    namespaceExpression = token;
    const resolved = resolveNamespaceToken(token, env);
    namespace = resolved.value ?? namespace;
    namespaceResolutionFailed =
      namespaceResolutionFailed || resolved.unresolved;
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "-A" || token === "--all-namespaces") {
      allNamespaces = true;
      continue;
    }
    if (token === "-n" || token === "--namespace") {
      setNamespace(args[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith("--namespace=")) {
      setNamespace(token.slice("--namespace=".length));
      continue;
    }
    if (token.startsWith("-n=") || token.startsWith("-n:")) {
      setNamespace(token.slice(3));
    }
  }

  return {
    namespace,
    namespaceExpression,
    namespaceResolutionFailed,
    allNamespaces,
  };
}

function findVerb(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--") return args[i + 1]?.toLowerCase() ?? null;
    if (token.startsWith("-")) {
      if (flagConsumesValue(token)) i += 1;
      continue;
    }
    return token.toLowerCase();
  }
  return null;
}

function kubectlInvocations(
  command: string,
  env: NodeJS.ProcessEnv,
): KubectlInvocation[] {
  const tokens = shellTokens(command);
  const invocations: KubectlInvocation[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    if (!isKubectlToken(tokens[i]!)) continue;

    const args: string[] = [];
    let j = i + 1;
    while (j < tokens.length && !isSeparator(tokens[j]!)) {
      args.push(tokens[j]!);
      j += 1;
    }

    const {
      namespace,
      namespaceExpression,
      namespaceResolutionFailed,
      allNamespaces,
    } = extractNamespace(args, env);
    invocations.push({
      raw: [tokens[i]!, ...args].join(" "),
      args,
      verb: findVerb(args),
      namespace,
      namespaceExpression,
      namespaceResolutionFailed,
      allNamespaces,
    });
  }

  return invocations;
}

function trustedEnvValue(key: string, env: NodeJS.ProcessEnv): string {
  return String(env[key] ?? "").trim();
}

function breakGlass(
  env: NodeJS.ProcessEnv,
): { approval: string; reason: string } | null {
  const approval =
    BREAK_GLASS_APPROVAL_KEYS.map((key) => trustedEnvValue(key, env)).find(
      Boolean,
    ) ?? "";
  const reason =
    BREAK_GLASS_REASON_KEYS.map((key) => trustedEnvValue(key, env)).find(
      Boolean,
    ) ?? "";

  if (!approval || !reason) return null;
  if (!APPROVAL_MARKER_RE.test(approval)) return null;
  if (reason.length < 12) return null;
  return { approval, reason };
}

function isReadOnlyKubectl(invocation: KubectlInvocation): boolean {
  if (!invocation.verb) return false;
  if (!READ_ONLY_KUBECTL_VERBS.has(invocation.verb)) return false;
  // `kubectl auth reconcile` writes RBAC; other auth subcommands are diagnostics.
  if (
    invocation.verb === "auth" &&
    invocation.args.some((arg) => arg.toLowerCase() === "reconcile")
  )
    return false;
  return true;
}

function isMutatingKubectl(invocation: KubectlInvocation): boolean {
  if (!invocation.verb) return false;
  if (MUTATING_KUBECTL_VERBS.has(invocation.verb)) return true;
  if (invocation.verb === "set" || invocation.verb === "rollout") return true;
  return !isReadOnlyKubectl(invocation);
}

function usesFileInput(invocation: KubectlInvocation): boolean {
  return invocation.args.some(
    (arg) =>
      arg === "-f" ||
      arg === "--filename" ||
      arg.startsWith("-f=") ||
      arg.startsWith("--filename="),
  );
}

function touchesAiModelsNamespace(invocation: KubectlInvocation): boolean {
  const namespace = invocation.namespace?.toLowerCase();
  return (
    namespace === AI_MODELS_NAMESPACE ||
    invocation.allNamespaces ||
    invocation.raw.includes(AI_MODELS_NAMESPACE)
  );
}

function touchesProtectedCortexSurface(invocation: KubectlInvocation): boolean {
  const raw = invocation.raw;
  const touchesAiModels = touchesAiModelsNamespace(invocation);
  const protectedModelName = MODEL_NAME_RE.test(raw);
  const protectedResource = PROTECTED_RESOURCE_RE.test(raw);
  const semanticKnob = SEMANTIC_KNOB_RE.test(raw);

  // ai-models is dedicated to Cortex model backends; mutating it directly bypasses
  // the Cortex deployment/orchestrator source of truth even when the exact resource
  // name is hidden behind -f/apply JSON/YAML.
  if (touchesAiModels) return true;

  // Also catch commands that omit -n but name a protected model-serving resource.
  return protectedModelName || (protectedResource && semanticKnob);
}

export function evaluateCortexKubectlGuardrail(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): CortexKubectlGuardrailDecision {
  const invocations = kubectlInvocations(command, env);
  const reasons: string[] = [];

  for (const invocation of invocations) {
    if (isReadOnlyKubectl(invocation)) continue;
    if (!isMutatingKubectl(invocation)) continue;
    const verb = invocation.verb ?? "unknown";

    if (invocation.namespaceResolutionFailed && usesFileInput(invocation)) {
      const expr =
        invocation.namespaceExpression ?? "unknown namespace expression";
      reasons.push(
        `kubectl ${verb} uses unresolved namespace expression (${expr}) with file-based mutation; refusing to prove it avoids protected Cortex model-serving surfaces: ${invocation.raw}`,
      );
      continue;
    }

    if (usesFileInput(invocation) && touchesAiModelsNamespace(invocation)) {
      const ns =
        invocation.namespace ??
        (invocation.allNamespaces
          ? "all namespaces"
          : "implicit/default namespace");
      reasons.push(
        `kubectl ${verb} uses file-based mutation against ai-models/Cortex model-serving namespace (${ns}); manifest contents must go through Cortex deployment/operator source of truth: ${invocation.raw}`,
      );
      continue;
    }

    if (!touchesProtectedCortexSurface(invocation)) continue;

    const ns =
      invocation.namespace ??
      (invocation.allNamespaces
        ? "all namespaces"
        : "implicit/default namespace");
    reasons.push(
      `kubectl ${verb} targets protected Cortex model-serving surface (${ns}): ${invocation.raw}`,
    );
  }

  if (reasons.length === 0) return { allowed: true };

  const marker = breakGlass(env);
  if (marker) return { allowed: true, breakGlass: marker };

  return {
    allowed: false,
    reasons,
    message: [
      "Blocked by Cortex model-serving guardrail.",
      "Autonomous agents must not mutate ai-models/Cortex model-serving Kubernetes resources directly.",
      "Use Cortex deployment/operator APIs as the source of truth for deploy, teardown, rollout, or runtime-arg changes; read-only kubectl diagnostics remain allowed.",
      "Break-glass requires BOTH SHIZUHA_CORTEX_BREAK_GLASS_APPROVAL=<human approval marker, e.g. human:hritik:CTX-###> and SHIZUHA_CORTEX_BREAK_GLASS_REASON=<specific reason> from the trusted runtime environment; inline command assignments do not count.",
      ...reasons.map((reason) => `- ${reason}`),
    ].join("\n"),
  };
}
