

## The UI

The substrate UI is actually a crucial part of the building this harness, but I guess we can keep it for v2, which should follow very quickly after v1.

## The skill activation

I would suggest keeping declarative skill activation as the primary way. The reflexive behaviour is actually theorically ideal, but in practice, it isn't that reliable, as agents don't reliable load the relevant skills optimally.
For instance, I would imagine the engineer agent would have the skills noted as part of its persona, which should guide the agent to load which skills in what situations exactly.
I'm open to discussing this, but I don't want to rely on progressive disclosure for reflexive activation. That way, IIUC, all agents will load all skills description, which eat away at their context windows, and might not even load the skills at the perfect time.
We can even consider placing skills in a non-trivial location to avoid that like in skills/substrate/journaling instead of skills/journaling if that prevents frontmatter loading.

## Modus operandi

The primary concern around making modus operandi operational is around the hand-offs and how  the hand-off propagation works. I get a sense that these modes are not to be encoded into operational agents and only the CEO and the TL, I wonder how that will turn out adherence wise. Is routing level intelligence sufficient for deciding how thoroughly a workflow runs? We can discuss further on it for its pros and cons against encoding these modes into crucial operational agents, that must be affected by it.

I guess most of these questions were answered in the dedicated session on Modus Operandi, so we can ignore this, unless if there a specific area/alert to focus on that I may have mentioned.

## Ideation, new-project, continuation flows; a few concerns

### Session continuation during hand-off

For a smooth hand-off I imagine a few scenarios, for instance:
1. **Background agents** - The CEO runs as a main and continuous session and spawns scout/propspector/smelter as background agents, meaning, the CEO session does not disconnect after handing off to scout and can hand-off to the next agent in the pipeline without its continued session/context.
2. **Agent teams** - The CEO runs as a team lead and spawns a team (using claude's agent teams feature) of these agents instead of as background agents, meaning the agents can hand-off amongst themselves, but the CEO session does not disconnect still and can benefit from continued session/context.
3. **Independent agents** - The CEO hands-off by spawning scout and disconnects. And when scout is done, it spawns CEO back once it's done. In this case, the CEO disconnects and respawns with fresh context load.

These are the options, not only for the ideation pipeline but for most of the sub-workflow pipelines to follow. Which of these are you imagining? Or are you imagining something new altogether.
I see, strong downsides in option 3. I see strongest upside in option 2. But I want to geniunely understand, with you, the capabilities and limitations of these options as per our needs. Keep in mind, Agents continuous with continued context is one of the most important parts of the problem we are aiming to solve here. Considering, cases like adversarial reviews during tech architecture etc must benefit from continued session contexts, right?

### Minimal semantic contract

During hand-off, there are distinct ways an agent can receive it, for instance in the ideation pipeline, it might go like:
* RawIdea -> CEO -> Scout -> Prospector
* RawIdea -> CEO -> Scout -> CEO -> Prospector
* SpecificIdea -> CEO -> Prospector

In all these cases, the prospector might receive a different prose, density and concreteness of information, should we consider establishing some sort of minimal semantic contract, so for instance, the prospector always receives certain information.
This is tricky, because setting that contract makes things less flexible, and lacking that contract might take it tricky for agents to continue. How do we imagine we target this?

## Semantic journal

Why not keep semantic journal to be jsonl as well instead of yml?

## File locations

Suggestions:
Parent dir for everyting here: /Users/laveesingh/Documents/software/experiments
Ideation: ./golem-ideas/<idea-dir>
Project: ./golem-projects/<project-dir>

skills: ~/.claude/skills/golem/<skill-category-dir>/<skill-dir>
agents: ~/.claude/agents/<agent-dir> 
Note: Agents location is tricky, I'd like to further nest them down in another directory, but here the visibility/resolution is my primary concern, can other agents trigger an agent that's not in standard global agents location? Happy to chat about our options further. Also, what about resolution when a global agent wants to call a project-level agent, can they even do that?

