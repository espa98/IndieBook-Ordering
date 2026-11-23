# Project Rules

## TDD (Test-driven Development) - MANDATORY
You must strictly follow the Red_Green-Refactor cycle for EVEY code change:

### The Cycle
1. RED : Write a failing test FIRST. Do NOT write any production code yet.
2. RUN the test and confirm it FAILS for the expected reason.
3. GREEN : Write the absolute MINIMUM code to make the test pass.
4. Run the test and confirm it PASSES.
5. REFACTOR : Clean up the code while keeping all tests green.

### Rules
- One test at a time. Never write multiple tests before making the first one pass.
- Never modify a test to make implementation pass. Tests are the source of truth.
- Never write production code without a failing test first.
- After Refator, always run tests again to ensure they still pass.