# toolsmith-mcp — working rules

## Testing is done by a different agent

The agent that writes the code does not validate it. Testing, QA, the final
validation gate (`FINAL_VALIDATION_REPORT.md`) and benchmark review run in a
separate, independent agent that gets the code and the spec, not the
builder's conclusions. The builder may write unit tests alongside changes, but
"it works" is only claimed after the independent agent has run it.

## End-user experience comes first

Setting this up must be easy for someone who is not the author:

- One command to start: `npx toolsmith-mcp init` then `npx toolsmith-mcp start`.
- Sensible defaults and no required config for a first run.
- Copy-pasteable client config snippets (stdio and HTTP) printed by the CLI.
- Every error says what went wrong and what to do next. No stack traces for
  user mistakes.
- The dashboard needs no build step and no separate install.
