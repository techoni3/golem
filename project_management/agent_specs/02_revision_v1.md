# Context

The v0 version of the substrate that is already established is quite different from the picture I had in mind.
I gave a lot of creative freedom to the agent and did not provide several decisions with conviction on purpose. 
We're going to aim for a substantial redesign with me trying to provide a clearer picture upfront. 

IMPORTANT: Pleaveese don't do boxed summaries output style for this sesssion, let's go with your standard output style.


# The current revision

The current substrate version has several upsides, downsides as well as elements that are yet to be judged for their effectiveness.

## The Good

* It provides me with some ideas where previously I had blind spots, meaning, I could be more thorough in the next revision design.


## The Bad

* Project-setup agent: the project setup agent needs to be more complete. Right now, it only does the golem standard setup, but not the project scaffolding. We need full project setup as per decided tech stack and architecture.
* ❓ Journal summarise step did not seem clearly plugged into the appropriate agents.
* ❓We probably don't need to separate files CONTEXT.md and CONTEXT-MAP.md, and just one CONTEXT.md should encapsulate both.


## The Unsure

* The agents design seems to be a little different than what I was expecting. The agent personas seem terse, seem to have insufficient prose and storyline.
* Should we keep top level files like ARCH.md, CONTEXT.md etc on the top level, if they can actually live in docs directory without any repurcussions so the top level is leaner, otherwise the top level grows too large over time.

# The new revision

## The conceptual flow
![alt text](<shape_A63cns9AIiANj_HUCNon1 at 26-05-02 19.21.33.png>)

The attached image showcases a high-level flow of the entire substrate picture I have in mind.
It showcases how progress flows, how collaborations happen, what agents are needed etc.

Now, this picture isn't perfect for details, and we're going to talk about the missing gaps, blind spots etc. I'm gonna note some of them down, and you're gonna highlight the rest.

## The agents roster

The roster is intentionally small and each persona has a sharp boundary. Personas are polyglot at the global level; project context is what specialises them. There is no human in the loop — the CEO and the TL together carry the routing and management responsibilities a human would otherwise hold.

### Routing & Orchestration

| Name | Description |
|---|---|
| CEO | Top-level entry for every user brief. Decides whether the brief is a fresh idea (route into the Ideation pipeline), an established idea ready for project setup (provision a project directory and hand off to a Project TL), or a continuation in an existing project (forward to that project's TL). Re-enters as the natural progression after Smelter picks an idea. Sets the Modus Operandi (Quick / Defer / Thorough) for the request. |
| TL | Owns a single project's end-to-end execution. Maintains the project tracker, sequences who runs next, routes feature requests through Product Architect → UX (if needed) → Tech Architect → engineering, routes fixes through Diagnoser → the right downstream team, and enforces the Modus Operandi inherited from the CEO on each ticket. The TL is the long-running, project-context-loaded driver — the work the CEO does not do itself. |

### Ideation

| Name | Description |
|---|---|
| Scout | Broad signal-gathering for fresh briefs. Scans communities, marketplaces, forums, search trends and competitor landscapes to surface a candidate list of raw product ideas with citations. Does not filter for viability — that's the next stage's job. |
| Prospector | Market-side filter. Takes Scout's candidates, runs market research (size, competition, distribution, willingness-to-pay) and turns the buildable ones into business cases the next stage can score. |
| Smelter | Final cut. Runs feasibility assessment across Prospector's business cases (build effort, differentiation, go-to-market, fit-with-our-stack) and picks the single most valuable idea worth pursuing, with reasoning. Hands the chosen idea back to the CEO. |

### Substrate

| Name | Description |
|---|---|
| Substrator | Bootstraps the agentic harness inside a new project directory. Initialises CONTEXT, CONTEXT-MAP, ARCH, the ADR template plus the first stack ADR, conventions, repo-map, journal hooks, the project tracker, and `.claude/settings.json`. Does not touch source code or scaffold the application — that belongs to the Tech Architect. |

### Product

| Name | Description |
|---|---|
| Product Architect | Turns a business brief into executable product specs: user journeys, feature breakdowns, acceptance criteria, edge cases. Output is detailed enough that the Tech Architect and UX Designer can act without re-deriving intent. |
| Product Architecture Reviewer | Independent critic of product specs. Looks for gaps, inconsistencies, scope creep, and misalignment with the business case. Iterates with the Product Architect until specs are sound. Held separate from the Architect to prevent self-approval. |
| UX Designer | Turns product specs into design specs: component breakdowns, layouts, interaction states, copy directions, navigation flows. Output is detailed enough that engineering can build a components storybook directly. Does not produce visual designs — there are no drawing tools in the loop. |

### Technical Architecture

| Name | Description |
|---|---|
| Tech Architect | Turns product specs into executable technical specs: stack choice, system boundaries, data model, API surface. Scaffolds the project per the chosen stack and writes the work decomposition into the project tracker as dev stories. Mindset is start-up — pragmatic, not over-engineered. |
| Tech Architecture Reviewer | Independent critic of technical specs. Reviews against non-functional requirements, scalability, security, ADR fit, and stack conventions. Iterates with the Tech Architect until the design is sound. Held separate from the Architect to prevent self-approval. |

### DevOps

| Name | Description |
|---|---|
| Local DevOps | Owns the developer experience inside the repo. Sets up the local stack (containers, services, scripts, tooling), seeds the first batch of "set up local dev env" stories before any feature work begins, and dictates the dev-env terms inside CONTEXT and ARCH so other agents follow them. |
| Cloud DevOps | Owns infrastructure. First-time infra and CI provisioning, the CI/CD pipeline, deployment on every PR merge to main, rollbacks and break-fix on failed deploys. Considers infra updates and scale requests from the TL only — not from individual engineers. |

### Development

| Name | Description |
|---|---|
| Engineer | Single polyglot engineering persona. Writes application code across the stack. Specialises at runtime through skills loaded from the project's CLAUDE.md (e.g. `python-fastapi-codestyle`, `nextjs-app-router`, `stripe`). Replaces what would otherwise be split into Frontend / Backend / Fullstack / Integrations personas — the persona is one, the skills do the splitting. |
| Test Spec Writer | Writes test scenarios, acceptance criteria, and edge cases for the engineer's commits. Held separate from the engineer to prevent reward hacking — the engineer cannot tune code-to-tests if it can't see or edit the spec. Triggered pre-commit. |
| Test Writer | Implements automated tests (unit, integration, e2e) against the Test Spec Writer's specs. Held separate from the engineer for the same reason. Triggered pre-commit, after the spec writer. |
| Code Reviewer | Reviews PRs against ticket spec, ARCH, ADRs, conventions, test quality, and verification evidence. Verdict is approve / request-changes / block. Held separate from the engineer so review is genuinely independent. |

### Diagnostics

| Name | Description |
|---|---|
| Diagnoser | Runs first when a fix request enters an existing project. Reproduces the issue, locates root cause, and classifies the fix as code / architecture / infra so the TL can route correctly. No fix is routed downstream without Diagnoser's verdict. |

### Maintenance

| Name | Description |
|---|---|
| Documentarian | Post-merge sweep. Reads the merged diff, journals, and agent-notes, then rewrites cross-cutting state (CONTEXT, ARCH, conventions, repo-map) and promotes recurring agent-notes into normative docs. Does not touch source code, tests, or ADRs. |
| Meta-agent | Substrate-evolution agent. Runs on cadence or on user trigger, reads journals across projects, proposes new skills, retires stale ones, flags persona drift, and surfaces patterns that warrant updates to the global agent personas or skill catalog. Lives outside the per-request flow. |

## Building the agents

The process of building these agents is also going to be a wholesome, iterative and a significant one. But here are a few intents as of now:
* The agents will be defined at global/user level, that are not specific to any one project.
* The agent personas will be quite rich but mostly polyglot and specific-tech agnostic. For instance, the Backend engineer persona will be of a really good yet generic backend engineer.
* But invoked into a specific project, the ingested project context will be such, they'll become of specialists of the speciality needed for that project.
* The agents will have a broader set of skills (sort of dormant in generic state), but in a project's context they'll have high focus on a particular set of skills. For instance, a BackendEngineer may have access to skills for Django, FastAPI, Ruby-on-Rails, but only when dropped into a FastAPI project, it becomes an excellent FastAPI BackendEngineer.
* Needless to say now, that the project context will activate certain skills-set while leaving others dormant depending on what's needed for the project.


## The skills catalog

The skills are what'll provide the generic agents specific personalities, and building these skills is also going to be an interesting, iterative process. Here are a few intents as of now:
* There'll be several categories of skills, like: technical-skills, substrate-skills, SOPs, etc.
* Technical skills might look like `fastapi-python`, `django-orm`, `alembic-sqlalchemy`, `aws-ecs`, `nextjs-typescript`, `stripe`, `supabase` etc.
* Substrate skills might look like `agent-notes`, `repo-map`, `journaling`, `tracker-update`, `context-update` etc.
* SOP skills might look like `diagnose`, `grill`, `pr-creation`, `git-trees`, `improve-architecture` etc.

These example skills are just examples, the final skills list will be determined after finalising the flow and list of agents and depending on what kind of skills the agents need in order to complete a flow thoroughly, the final skills list will emerge.

We'll be brainstorming about what type of typical project stacks do we want to build support for upfront, and that'll also dictate which technical skills and integration skills do we need to encode right away.

## Substrate Components

### Context Docs

This is the good parts of the previous revision, that I didn't consider much thoroughly, but I can understand their importance now.

* **CLAUDE.md**: The entrypoint for agents to know about the project, and it requires a clever design because we do need to consider most, if not all, all the agents will load it. Here are few considerations I have for this.
    - We can't be too thorough in prose in this file, otherwise it'll get too long trying to address all the agents and all the cases.
    - We can't be too narrow in this, otherwise we'll miss some essential instructions.
    - We need to consider that the agents will have their own personas telling them how they will operate in general, in addition to that, we'll have skills that'll tell the agents on hwo they will operate for specific cases. There will also be substrate skills that'll brief them about how to do stuff on substrate level.
    - Then, we need consider what are we really left  that the agents neeed to know? I can't really think of much clearly, and I'd need your help figuring this out. Whatever I can think of will introduce redundancy (be it for substrate ops or otherwise) maybe worth for increased assurance that agents won't deviate due to redundancy. But we have to assess this thoroughly.
* **CONTEXT.md and CONTEXT-MAP.md**: The importance of this is more clear to you than it is to me, but I agree with it nonetheless. I would appreciate it, though, if you could clarify this a little bit furhter for me. The most important thing will be the wiring into the context loading mechanism, like which agents will load them up, when and how.
* **ARCH.md**: Similarly, I understand its essence, but the important part is how its loaded, by which agents and when.
* **README.md**: I assume, this is not for the agents, but for humans. No additional comment in that case.
* **conventions**: I'd like to understand a bit more about it and its importance.
* **repo-map.md**: I understand on a high-level its importance, but I'd like to understand this in-depth, what exactly does it do, which agents interact with it and how.

### Agents Trace

This is what'll provide visibility and insights into the black-box of agent harness during and after execution, to both the agents (meta or oepration), and me (the human).

We sort of already established this well, in v0, with ADR records, Agent notes, and Journals (mechanical hooks as well as semantic summaries).

However, we need to ensure proper wiring for these to ensure that the agents actually as produce the results as expected. So just tell me how you think the wiring will work for these.

### Project Tracker

For this, I'm struggling to decide how exactly should the project tracker function.
Should we have simple format files to maintain the records, or create a static file-like database (sqlite3 or something simpler) for managing this properly. 
One thing we want to ensure is to keep it local, in-repo management of this tracker.

But I'm curious to discuss if there are other more creative ways to do this, which provide enough structure and convenience at the same time to the agents to be able to track enough details in tickets and move them around like a scrum board like a typical tickets management tool like Linear, Asana or even Github Projects.

### Hooks

This is a topic which I know a little about, and I'm curious to explore more. But this is also not something I wanna let loose on, I mean this probably one of few parts where being strict makes sense.

I know we need to maintain certain hooks for post-processing, guardrails, events etc, e.g., linting, formatting, git guardrails, journaling events etc.
But what else should we be considering for this.


## The final flow

[[ TBD ]]


# Raw Ideas (for later)

* Modus Operandi: Quick (be quick deliver fast, no need to be thorough non-essential SOPs), Defer (be quick deliver fast, do a thorough revision asynchronously), Thorough (default, follow instructions thoroughly)
* Turn into a UI interface to interact with the substrate; a full visual journey like n8n provides but more visually appealing, and more fun; we could see agents checking in and out through using session hooks to commit their status etc; we could see project tracker being consumed in real-time etc; 


# Revising now
## Agent says

* The thing I want to push back on hardest: the expanded roster is fine only if Modus Operandi (your "Raw Ideas" item) gets pulled out of "later" and into the core flow. Agreed.
* Journal summarising: agent provides 3 suggestions and none of them are viable. Human running the summarise command is not possible because there's no human in the loop. Documentarian's sweep can't do it because it needs to be same agent who dumps the summary whose session just ended. Same for the 3rd option, a separate summarise agent doesn't cut it.
* Test Spec Writer + Test Writer as two agents: agent suggests keeping a single agent with different skills. I can agree to do that. But my main concern here was to prevent the agents from reward hacking. If the same agent has access writing code and tests, it might overtune code to pass tests, or overtune tests to pass code even when the behaviour is fault against specs. But I guess keeping it from the engineer is enough.
* Agent also suggests keeping only one full stack engineer persona instead of 3 split ones, especially because the skills already do the split personality loading. I can agree to that.
* The agent doesn't understand the exact purpose of scout/prospector/smelter, understanding the conceptual flow image is essential to understand where they fit in. It should be clearer now.
* The agent points out that there is not PM/TL persona in the roster, which is correct, and it's because I forgot about it. We're going to have a CEO (no PM) and a TL persona included into the roaster. Assume no human in the loop at all.
* Meta agent is missing as well, well I need look it up again on what its roles and responsibility were to be.
* CLAUDE.md design proposed by the agent is sort of interesting, need to go back to it again.
* agent references v0 skills/terms, need to make it clear that we're going to dump the entire v0 scaffold to an archive to start fresh, to avoid unwanted drift.
* Project tracker: agent prefers to keep it markdown; however it feels like it may be token-expensive to edit large markdown files constantly. Although, agent's reasoning regarding substrating being self-describing and keeping it simple makes sense as well.
* Ignore additional hooks for now.
* Agent asks, what activates a skill? Well, it was a conceptual notion rather than a hard contract. It basically means, claude.md's declarations as well as skill's `use when` frontmatter will load the skills to agent context.
* 2 test agents and `tdd` skill, where do they live and how they're invoked, also require clean handoff from coder to test agents without being confused by tdd. This requires a bit of thinking.


