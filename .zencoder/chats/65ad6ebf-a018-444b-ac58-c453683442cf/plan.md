# Spec and build

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification

Assess the task's difficulty, as underestimating it leads to poor outcomes.

- easy: Straightforward implementation, trivial bug fix or feature
- medium: Moderate complexity, some edge cases or caveats to consider
- hard: Complex logic, many caveats, architectural considerations, or high-risk changes

Create a technical specification for the task that is appropriate for the complexity level:

- Review the existing codebase architecture and identify reusable components.
- Define the implementation approach based on established patterns in the project.
- Identify all source code files that will be created or modified.
- Define any necessary data model, API, or interface changes.
- Describe verification steps using the project's test and lint commands.

Save the output to `c:\Users\Don't\Documents\Kisekai Bot\.zencoder\chats\65ad6ebf-a018-444b-ac58-c453683442cf/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

---

### [ ] Step: Implementation

Implement the task according to the technical specification and general engineering best practices.

1. [ ] Implement backend endpoint `GET /api/messages/:channelId/:messageId` in `index.js`.
2. [ ] Add `getMessage` function to `Kisekai-DashBoard/src/lib/api.ts`.
3. [ ] Update `BroadcastForm.tsx` to include message pulling UI and logic.
4. [ ] Verify the feature by pulling real message IDs from Discord.
5. [ ] Run lint/build if applicable.
6. [ ] Write report to `c:\Users\Don't\Documents\Kisekai Bot\.zencoder\chats\65ad6ebf-a018-444b-ac58-c453683442cf/report.md`.
