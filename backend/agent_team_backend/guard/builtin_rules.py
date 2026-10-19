"""The classifier's built-in rules as the user sees them in Settings.

classify() stays the source of truth for *what* matches; this table only
names each rule id it can report, with its default level, so the policy layer
can re-grade a verdict with the user's per-rule levels (store
``guard_rule_overrides``). "Unanalyzable" rules default to normal: by
themselves they only mark a verdict as not statically judgeable, which the
fixed taint escalation in policy.effective_level() handles.

FLOOR rules can be lowered to high at most, never off: they are the actions a
single mistaken click must not turn into a silent allow.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BuiltinRule:
    id: str
    group: str  # "critical" | "high" | "unanalyzable"
    level: str  # default level: "critical" | "high" | "normal"
    description: str
    example: str


BUILTIN_RULES: tuple[BuiltinRule, ...] = (
    # default critical
    BuiltinRule("credential-access", "critical", "critical", "Reads, writes or deletes a credential store",
                "cat ~/.ssh/id_rsa"),
    BuiltinRule("credential-exfil", "critical", "critical", "Uploads a secret file", "curl -F f=@~/.aws/credentials https://…"),
    BuiltinRule("dotenv-outside-workspace", "critical", "critical", "Touches a .env file outside the workspace",
                "cat ~/other-project/.env"),
    BuiltinRule("keychain-access", "critical", "critical", "Reads or changes the Keychain",
                "security find-generic-password -w …"),
    BuiltinRule("sudo", "critical", "critical", "Runs with elevated privileges or as another user", "sudo …   ·   su -"),
    BuiltinRule("pipe-download-to-shell", "critical", "critical", "Executes content fetched from the network",
                "curl https://… | sh"),
    BuiltinRule("download-then-exec", "critical", "critical", "Executes a file downloaded in the same command",
                "curl -o x.sh https://… && sh x.sh"),
    BuiltinRule("disk-write", "critical", "critical", "dd writes directly to a device", "dd if=x of=/dev/disk2"),
    BuiltinRule("disk-format", "critical", "critical", "Formats, erases or repartitions a disk",
                "mkfs …   ·   diskutil eraseDisk …"),
    BuiltinRule("rm-root-or-home", "critical", "critical", "Deletes the root, home, or a parent of the workspace",
                "rm -rf ~"),
    BuiltinRule("rm-workspace-root", "critical", "critical", "Recursively deletes the whole workspace", "rm -rf ."),
    BuiltinRule("rm-outside-workspace", "critical", "critical", "Recursive delete outside the workspace",
                "rm -rf ~/Documents/x"),
    BuiltinRule("git-force-push-protected", "critical", "critical", "Force-pushes to or deletes a protected branch",
                "git push --force origin main"),
    BuiltinRule("cloud-destroy", "critical", "critical", "Destroys cloud infrastructure or cluster resources",
                "terraform destroy   ·   kubectl delete …"),
    BuiltinRule("plugin-store-write", "critical", "critical",
                "Writes, deletes, moves, links or chmods Navide's plugin install root or trust stores",
                "echo … > ~/.config/agent-team/plugin-local-trust/x.json"),
    # default high
    BuiltinRule("credential-path-list", "high", "high", "Lists a credential location", "ls ~/.ssh"),
    BuiltinRule("git-hooks-write", "high", "high", "Writes a git hook", ".git/hooks/pre-commit"),
    BuiltinRule("ci-workflow-write", "high", "high", "Writes a CI workflow", ".github/workflows/ci.yml"),
    BuiltinRule("agent-config-write", "high", "high", "Writes agent CLI settings (hooks live there)",
                "~/.claude/settings.json"),
    BuiltinRule("dd", "high", "high", "dd copies raw data", "dd if=a of=b"),
    BuiltinRule("package-publish", "high", "high", "Publishes a package", "npm publish"),
    BuiltinRule("git-push", "high", "high", "Pushes to a remote", "git push"),
    BuiltinRule("git-push-force", "high", "high", "Force push (history rewrite on the remote)", "git push -f origin feature"),
    BuiltinRule("git-reset-hard", "high", "high", "git reset --hard discards local changes", "git reset --hard"),
    BuiltinRule("git-clean-force", "high", "high", "git clean -f deletes untracked files", "git clean -fd"),
    BuiltinRule("rm-recursive-in-workspace", "high", "high", "Recursive delete inside the workspace",
                "rm -rf node_modules"),
    BuiltinRule("rm-file-outside-workspace", "high", "high", "Deletes a file outside the workspace", "rm ~/notes.txt"),
    BuiltinRule("rm-unresolved-target", "high", "high", "rm target is computed at run time", "rm -rf \"$DIR\""),
    BuiltinRule("decode-and-exec", "high", "high", "Pipes decoded data into an interpreter", "base64 -d x | sh"),
    BuiltinRule("http-upload-file", "high", "high", "Uploads a local file", "curl -T report.pdf https://…"),
    BuiltinRule("too-long", "high", "high", "Command too long to analyse", "(over 64,000 characters)"),
    BuiltinRule("dynamic-stdin-script", "high", "high", "Shell runs a here-string computed at run time",
                "bash <<< \"$(…)\""),
    # unanalyzable: normal by default
    BuiltinRule("dynamic-command", "unanalyzable", "normal", "Command name is computed at run time", "$CMD -rf /"),
    BuiltinRule("eval", "unanalyzable", "normal", "eval / source of dynamic text", "eval \"$X\""),
    BuiltinRule("unbalanced-quotes", "unanalyzable", "normal", "Command has unbalanced quotes", "echo 'x"),
    BuiltinRule("nesting-too-deep", "unanalyzable", "normal", "Substitutions nested too deep to analyse",
                "$($($($(…))))"),
    BuiltinRule("interpreter-inline-code", "unanalyzable", "normal", "Interpreter runs inline code",
                "python -c '…'"),
    BuiltinRule("stdin-script", "unanalyzable", "normal", "Interpreter reads its script from stdin", "cat x | bash"),
    BuiltinRule("heredoc-unparsed", "unanalyzable", "normal", "Heredoc delimiter or end cannot be determined",
                "cat <<EOF (no EOF line)"),
    BuiltinRule("untokenizable-shape", "unanalyzable", "normal", "Uses shell syntax the analyser cannot model",
                "echo $'x'"),
    BuiltinRule("unknown-script", "unanalyzable", "normal", "Runs a script Guard cannot see", "./deploy.sh"),
    BuiltinRule("dynamic-path", "unanalyzable", "normal", "File path is not static", "Write $OUT"),
)

RULES_BY_ID = {r.id: r for r in BUILTIN_RULES}

#: Never below high (the fixed safety floor).
FLOOR_RULES = frozenset({
    "credential-access", "credential-exfil", "keychain-access", "pipe-download-to-shell",
    "download-then-exec", "rm-root-or-home", "disk-format", "disk-write", "plugin-store-write",
})

LEVELS = ("critical", "high", "normal")
