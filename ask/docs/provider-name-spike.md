# Provider/name spike

Phase 0 decision: keep the Claude-compatible tool name `AskUserQuestion` as the default.

Local Pi validation performed during development:

- Registered a tool named `AskUserQuestion` from the package entrypoint.
- Started Pi in offline RPC mode with the package loaded.
- Verified the extension loads and the tool can be active without a permission gate.

Provider notes:

- Pi's tool model accepts `AskUserQuestion` as a registered tool name.
- Anthropic/OpenAI-compatible providers are expected to accept uppercase ASCII tool/function names, but provider-specific live calls should still be checked before publishing broadly.
- If a provider rejects the name later, add a single opt-in lower-case alias such as `ask_user_question`; do not expose both names by default because it can confuse model choice.
