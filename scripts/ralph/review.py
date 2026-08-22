import json
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from scripts.ralph.sandbox import (
    SandboxCommandResult,
    TenkiSandbox,
)
from scripts.ralph.workspace import TicketWorkspace


NEBIUS_CHAT_URL = (
    "https://api.tokenfactory.nebius.com/v1/"
    "chat/completions"
)

# Reviewer content is untrusted output.  It must NEVER
# appear in ReviewError text because that text is
# persisted into checkpoint.last_error.  Persisted
# ReviewError messages are static categorical error
# codes only — no content substring, no content hash,
# no content length, no content prefix/suffix, no
# content fingerprint of any kind.

# Stable internal error categories.  These are static
# identifiers — they are NOT derived from model
# output, subprocess output, prompts, or diffs.
REVIEW_INVALID_JSON = "RALPH_REVIEW_INVALID_JSON"
REVIEW_UNKNOWN_VERDICT = (
    "RALPH_REVIEW_UNKNOWN_VERDICT"
)
REVIEW_VERDICT_INVALID_FOR_STAGE = (
    "RALPH_REVIEW_VERDICT_INVALID_FOR_STAGE"
)
REVIEW_FINDINGS_NOT_LIST = (
    "RALPH_REVIEW_FINDINGS_NOT_LIST"
)
REVIEW_MALFORMED_FINDING = (
    "RALPH_REVIEW_MALFORMED_FINDING"
)
REVIEW_MISSING_CONTENT = (
    "RALPH_REVIEW_MISSING_CONTENT"
)
REVIEW_INVALID_WRAPPER_JSON = (
    "RALPH_REVIEW_INVALID_WRAPPER_JSON"
)
REVIEW_NEBIUS_FAILED = "RALPH_NEBIUS_FAILED"
REVIEW_NEBIUS_TIMEOUT = "RALPH_NEBIUS_TIMEOUT"


class ReviewError(RuntimeError):
    pass


class ReviewStage(str, Enum):
    PRE_QA = "PRE_QA"
    PRE_PERSISTENCE = "PRE_PERSISTENCE"


class ReviewVerdict(str, Enum):
    FIX_BEFORE_QA = "FIX_BEFORE_QA"
    APPROVE_FOR_QA = "APPROVE_FOR_QA"

    BLOCK_PERSISTENCE = "BLOCK_PERSISTENCE"
    APPROVE_FOR_PERSISTENCE = (
        "APPROVE_FOR_PERSISTENCE"
    )


@dataclass(frozen=True)
class ReviewFinding:
    severity: str
    title: str
    details: str


@dataclass(frozen=True)
class ReviewResult:
    stage: ReviewStage
    verdict: ReviewVerdict
    summary: str
    findings: tuple[ReviewFinding, ...]

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ReviewRunner:
    def __init__(
        self,
        sandbox: TenkiSandbox,
        workspace: TicketWorkspace,
        model: str,
        api_key: str,
        max_tokens: int = 6000,
    ):
        self.sandbox = sandbox
        self.workspace = workspace
        self.model = model
        self.api_key = api_key
        self.max_tokens = max_tokens

    def review(
        self,
        *,
        issue_number: int,
        issue_context: str,
        stage: ReviewStage,
        previous_findings: Optional[str] = None,
        qa_evidence: Optional[str] = None,
    ) -> ReviewResult:
        diff_text = self._read_complete_diff()

        if not diff_text.strip():
            raise ReviewError(
                "Cannot review an empty implementation diff."
            )

        prompt = self._build_prompt(
            issue_number=issue_number,
            issue_context=issue_context,
            diff_text=diff_text,
            stage=stage,
            previous_findings=previous_findings,
            qa_evidence=qa_evidence,
        )

        response = self._call_nebius(prompt)

        return self._parse_response(
            response,
            stage=stage,
        )

    def _read_complete_diff(self) -> str:
        result = self.sandbox.exec(
            "bash",
            "-lc",
            r"""
    set -euo pipefail

    cd "$RALPH_REPOSITORY_PATH"

    git rev-parse --verify HEAD >/dev/null

    git diff \
    --binary \
    --full-index \
    HEAD \
    -- .

    while IFS= read -r -d '' file
    do
        git diff \
        --no-index \
        --binary \
        --full-index \
        /dev/null \
        "$file" \
        || true
    done < <(
        git ls-files \
        --others \
        --exclude-standard \
        -z
    )
    """,
            env={
                "RALPH_REPOSITORY_PATH":
                    self.workspace.repository_path,
            },
        )

        if result.exit_code != 0:
            # Persisted ReviewError text flows into
            # checkpoint.last_error.  The git diff
            # subprocess stdout/stderr are untrusted
            # and MUST NOT be persisted.  Use only the
            # numeric process boundary exit code.
            raise ReviewError(
                "Unable to capture implementation diff.\n"
                f"exit_code={result.exit_code}"
            )

        return result.stdout

    def _build_prompt(
        self,
        *,
        issue_number: int,
        issue_context: str,
        diff_text: str,
        stage: ReviewStage,
        previous_findings: Optional[str],
        qa_evidence: Optional[str],
    ) -> str:
        if stage == ReviewStage.PRE_QA:
            allowed_verdicts = (
                "FIX_BEFORE_QA or APPROVE_FOR_QA"
            )
            objective = (
                "Determine whether this implementation "
                "is ready for executable QA."
            )
        else:
            allowed_verdicts = (
                "BLOCK_PERSISTENCE or "
                "APPROVE_FOR_PERSISTENCE"
            )
            objective = (
                "Determine whether this already-tested "
                "implementation is safe to persist."
            )

        previous = (
            previous_findings.strip()
            if previous_findings
            else "None."
        )

        if qa_evidence:
            qa = qa_evidence.strip()
        elif stage == ReviewStage.PRE_QA:
            qa = (
                "Not applicable at this stage. "
                "Executable QA has intentionally not run yet. "
                "Do not create a finding merely because QA evidence "
                "is absent during PRE_QA review."
            )
        else:
            qa = (
                "Missing. PRE_PERSISTENCE review must fail closed "
                "when required QA evidence has not been supplied."
            )

        return f"""
You are the independent senior software-engineering
reviewer in Ralph, an autonomous implementation system.

You DID NOT implement this change.

Your job is to find real correctness, specification,
migration, regression, testing, security, integration,
and maintainability defects.

Do not approve merely because the implementation looks
plausible.

Review stage:
{stage.value}

Objective:
{objective}

GitHub issue:
#{issue_number}

AUTHORITATIVE ISSUE CONTEXT
---------------------------
{issue_context}

PREVIOUS REVIEW FINDINGS
------------------------
{previous}

QA EVIDENCE
-----------
{qa}

IMPLEMENTATION DIFF
-------------------
{diff_text}

REVIEW RULES
------------
1. Treat the issue context as authoritative.
2. Check every acceptance criterion.
3. Inspect migration ordering and historical schemas.
4. Check retry/idempotency behavior where relevant.
5. Look for regression risks.
6. Check that tests actually prove their claims.
7. Do not focus on formatting trivia.
8. Do not modify files.
9. Do not propose unrelated redesigns.
10. Fail closed when important evidence is missing.
11. During PRE_QA, absence of QA evidence is expected and is
    not itself a defect.
12. During PRE_PERSISTENCE, required QA evidence must be
    present or persistence must be blocked.

Return JSON ONLY.

The JSON must have exactly this shape:

{{
  "verdict": "{allowed_verdicts}",
  "summary": "short overall assessment",
  "findings": [
    {{
      "severity": "BLOCKING|SHOULD_FIX|NON_BLOCKING",
      "title": "short finding title",
      "details": "specific explanation"
    }}
  ]
}}

The verdict value itself must be ONE of the allowed
verdict strings, not the entire allowed-verdict phrase.
""".strip()

    def _call_nebius(
        self,
        prompt: str,
    ) -> dict:
        request_payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are an independent, strict "
                        "senior software engineer reviewing "
                        "autonomous code changes."
                    ),
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
            "temperature": 0,
            "max_tokens": self.max_tokens,
            "response_format": {
                "type": "json_object",
            },
        }

        script = f"""
import json
import os
import sys
import urllib.request

payload = json.load(sys.stdin)

request = urllib.request.Request(
    {NEBIUS_CHAT_URL!r},
    data=json.dumps(payload).encode(),
    headers={{
        "Authorization":
            "Bearer " + os.environ["NEBIUS_API_KEY"],
        "Content-Type": "application/json",
    }},
)

with urllib.request.urlopen(
    request,
    timeout=600,
) as response:
    result = json.load(response)

message = result["choices"][0]["message"]["content"]

print(
    json.dumps(
        {{
            "content": message,
            "usage": result.get("usage", {{}}),
        }}
    )
)
""".strip()

        result = self.sandbox.exec(
            "python3",
            "-c",
            script,
            env={
                "NEBIUS_API_KEY": self.api_key,
            },
            input=json.dumps(request_payload),
            timeout=660,
        )

        if result.exit_code != 0:
            # Persisted ReviewError text flows into
            # checkpoint.last_error.  The subprocess
            # stdout/stderr are untrusted and MUST NOT
            # be persisted.  Only the numeric process
            # boundary exit code is safe to expose.
            #
            # The static message uses vocabulary that
            # is deliberately disjoint from any
            # plausible secret string so a substring
            # scan can prove no leak without false
            # positives.
            raise ReviewError(
                "Reviewer subprocess invocation failed.\n"
                f"exit_code={result.exit_code} "
                f"code={REVIEW_NEBIUS_FAILED}"
            )

        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            # Persisted ReviewError text flows into
            # checkpoint.last_error.  The wrapper
            # JSON is untrusted and MUST NOT be
            # persisted.
            raise ReviewError(
                "Reviewer subprocess returned invalid "
                f"wrapper JSON. code={REVIEW_INVALID_WRAPPER_JSON}"
            ) from error

    def _parse_response(
        self,
        response: dict,
        *,
        stage: ReviewStage,
    ) -> ReviewResult:
        content = response.get("content")

        if not isinstance(content, str):
            # Persisted ReviewError text flows into
            # checkpoint.last_error.  Use a static
            # categorical message; never embed the
            # response value.
            raise ReviewError(
                "Reviewer response is missing content. "
                f"code={REVIEW_MISSING_CONTENT}"
            )

        stripped = self._strip_code_fence(
            content.strip()
        )

        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError as error:
            # Reviewer content is untrusted output.
            # It MUST NEVER appear in ReviewError
            # because ReviewError text is persisted
            # to checkpoint.last_error.  Use only a
            # static categorical message and the
            # stable error code.
            raise ReviewError(
                "Reviewer did not return valid "
                f"verdict JSON. code={REVIEW_INVALID_JSON}"
            ) from error

        try:
            verdict = ReviewVerdict(
                payload["verdict"]
            )
        except (
            KeyError,
            ValueError,
        ) as error:
            raise ReviewError(
                "Reviewer returned an unknown "
                f"verdict. code={REVIEW_UNKNOWN_VERDICT}"
            ) from error

        self._assert_verdict_allowed(
            stage,
            verdict,
        )

        raw_findings = payload.get(
            "findings",
            [],
        )

        if not isinstance(raw_findings, list):
            raise ReviewError(
                "Reviewer findings must be a list. "
                f"code={REVIEW_FINDINGS_NOT_LIST}"
            )

        findings = []

        for raw_finding in raw_findings:
            try:
                findings.append(
                    ReviewFinding(
                        severity=str(
                            raw_finding["severity"]
                        ),
                        title=str(
                            raw_finding["title"]
                        ),
                        details=str(
                            raw_finding["details"]
                        ),
                    )
                )
            except (
                KeyError,
                TypeError,
            ) as error:
                raise ReviewError(
                    "Reviewer returned malformed "
                    f"finding. code={REVIEW_MALFORMED_FINDING}"
                ) from error

        usage = response.get(
            "usage",
            {},
        )

        return ReviewResult(
            stage=stage,
            verdict=verdict,
            summary=str(
                payload.get(
                    "summary",
                    "",
                )
            ),
            findings=tuple(findings),
            prompt_tokens=int(
                usage.get(
                    "prompt_tokens",
                    0,
                )
            ),
            completion_tokens=int(
                usage.get(
                    "completion_tokens",
                    0,
                )
            ),
            total_tokens=int(
                usage.get(
                    "total_tokens",
                    0,
                )
            ),
        )

    @staticmethod
    def _strip_code_fence(
        content: str,
    ) -> str:
        if not content.startswith("```"):
            return content

        lines = content.splitlines()

        if lines:
            lines = lines[1:]

        if (
            lines
            and lines[-1].strip() == "```"
        ):
            lines = lines[:-1]

        return "\n".join(lines).strip()

    @staticmethod
    def _assert_verdict_allowed(
        stage: ReviewStage,
        verdict: ReviewVerdict,
    ) -> None:
        allowed = {
            ReviewStage.PRE_QA: {
                ReviewVerdict.FIX_BEFORE_QA,
                ReviewVerdict.APPROVE_FOR_QA,
            },
            ReviewStage.PRE_PERSISTENCE: {
                ReviewVerdict.BLOCK_PERSISTENCE,
                ReviewVerdict.APPROVE_FOR_PERSISTENCE,
            },
        }

        if verdict not in allowed[stage]:
            raise ReviewError(
                "Reviewer returned a verdict that is "
                "invalid for the current stage. "
                f"code={REVIEW_VERDICT_INVALID_FOR_STAGE}"
            )