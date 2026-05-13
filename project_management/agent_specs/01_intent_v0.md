# Context

Currently, the claude code agent harness is amazing. It's built-in toolbox is quite broad and capable, and the harness and architectural tools like memory, context-management, subagents, agent teams etc are quite powerful and get most of the day to day work done. To be honest, there's no real struggle I can report with the way I've been working with claude. However, I believe it's time to evolve my way of working altogether. If we were to look at how I work with claude code on an autonomy slider I'd say I'm at 50%, meaning I'm relying quite heavily on agentic capabilities to get most of the stuff done, but I'm still involved quite heavily in all levels of decision making, checkpoints and basically I go step by step, task by task and mostly checking on a high-level all that work that's being done. That doesn't mean I'm checking every low-level decision, or even line of code, but I still am keeping a close eye on everything being produced, and I go by one tiny work segment at a time. So, in a way, I'm constantly in the loop and constantly guiding the agent and providing my decision points all the way.
With this evolution, however, I want to relinquish more control and provide more autonomy to the agent, while increasing its consistency and reliability at the same time. It's a big challenge. Even though I'm looking to relinquish control during runtime, I'm intending to frontload a lot of my opinions, workflows, skills and whatnot, so the agent still follows what I'd like it to following but without me needing to direct it along the way, but rather relying on carefully created/curated claude rules/configs/skills etc.

# What I have in mind

I probably need better understanding to be able to describe in the modern and standard terms of what I'm thinking. Furthermore, I may not even know what I want, I just may have a blurry picture in my head of what I want. Regardless, I'm doing to try and describe what the end result may look like. But don't consider this picture as a final picture, because I want to brainstorm with you to modify, codify and standardise that picture even more.
Anyways, below is what I have in mind so far.

## Entrypoint

Today, I only work with the agent when I'm sitting in front of a computer, have the terminal and claude code cli open. It works great, but that's the only way I'm working with it, and this will probably be the majority of how I'm gonna continue working. But, I'll also like to be able to remote control some of the work. I would like to be able to delegate some work through whatsapp/telegram/slack from my phone even (especially) when I'm away from my computer. I would also like if it could auto pick work items from github issues for example (or some other project management tool.).
I'm not sure, however, whether the cloud managed agents are the way to go with that, or we can acheive that on local claude setup as well. If cloud managed agents are the way, would they share the configs/skills/scripts that local setup has or not. If local setup can do the job, how are we going to make that work, considering the computer may not always be awake for instance.
So, this is something I want to happen, but this is not a p0, it's something that'll be very good to have, but not an essential. And, I'm not quite sure how to achieve that.

## Work orchestration

There will be two types of work that'll trigger the agent to run. Either, starting a new project from scratch, or a task/PR in an existing project. These two work paths share some similarities on the orchestration substrate, but are also fundamentally different from a scope and capabilities point of view.

For triggers that are essentially a patch/task/issue/PR in an existing project, the path may look like:
SlackBot/GithubIssue (remote trigger) --(project specific manager agent trigger)--> PM/TeamLeadAgent --(project team delegation)--> Project Team Agents

For triggers that require booting up a new project, the path may look like:
Triggers --(global project setup agent)--> Project Setup Agent --(creates project, agents team etc, and triggers team)--> PM/TeamLeadAgent --(project team delegation) --> Project Team Agents

These may be over simplified to provide a high level understanding of what kind of setup I'm looking for. Note, the trigger can include claude code session itself.

## Reliability engineering

This is where we're going to spend most of our efforts, and the ceiling here is practically infinite, so we'll probably keep iterative improvements in mind. The intent is to make the harness more and more reliable and consistent.
Like, if I had a real team, there'd certainly be some training and alignment time, but after a while, I can expect consistent standards, enforceable SOPs, autonomous work distribution, reliable work delivery etc. Similar is the idea with it. The system should get better and better with run more and more autonmously with less and less insights, behaving like it knows me and what I want better and better.
How exactly are we going to achieve an ever increasing reliability is a matter of your investigation and our brainstorming.
But a couple things that I have in mind, that I'd like to explore with you.

### Project State and Memory

#### Project State
Project state here, in my mind, refers to architecture, docs, rules (even project level skills if needed) etc that the agents can quickly refer to get up to speed about the current project state before starting their current work session. Now, of course, this is going to be a living system that each agent session may update after their work is done. What shape or form is this state going to be managed is still to be decided. But a blurry idea that I have in that we may have something like a aider's tree-sitter, page rank for an easier glance repo map, in parallel with an architecture doc that may provide additional info on-demand about the architecture itself as well as the architectural decisions that may be crucial for the variety of agents to know during runtime. This could serve as an entrypoint, but further documentation may be embedded into code through file-level docstrings as well as in-code docstrings. This should prove crucial as it may be assist during code search for optimal reusability, tracing, diagnosing, refactoring, testing and whatnot.

Obviously, we'd need to make it imperative to the agents the project is to be created and maintained by agents, so it's practices are architected that way. In a way, the project is "of the agents", "by the agents", "for the agents". So, the practices need to be optimal for agentic behaviours and not humans. There can be some capabilities we can enhance this way, and some limitations we can mitigate this way.

#### Project Tracker
In addition to that, we're also going to want to have a project tracker in-code, consider this a replacement for external project management tools like linear, asana etc. This should help both the agents and humans easily track progress, plan roadmaps, distribute upcoming work across agents etc. Now, this is soemthing that might prove to be counter-productive, but I just have this idea, however, radical. So, we'd like to evaluate whether doing it is a good idea.

#### Memory
I'm not too certain about what I can do for better memory, because I've just been using claude and it has a buil-in memory mechanism. I'm aware that better memory leads to better agents resumption and continuity. But I'm happy to explore what we can (if we can) do to better the memory.



## Agents, subagents, and agent teams

### Imagined setup
I imagine a real-word like team setup. There can be a project manager that dictates everything about the project, from ideation, design, solutioning, architecture etc, and an optional TL and then the entire team of researchers, architects, designers, developers, testers, devops etc. Each agent persona will be role-scoped, and will have mastery for that role, in a more polyglot and language-agnostic way, and depending on how the technological and architectural decisions are made, they focus on the relevant skills. For instance, a backend developer agent might know django, fastapi and ruby-on-rails stack, but depending on which stack is chosen, they just hone down on that. Similarly, a dev ops agent might know how to work with both aws and azure, but may use a specific skillset depending on the project architecture itself.

The project manager can be thought of as an entrypoint to the project and project level work, the TL may be thought of as the one that spanws agent teams, manages the continuous progress, facilitates the necessary communication, context-handoff, verifier agents etc.
We can define a superset of skills that the different agents will have access to as per their persona, these skills don't have to start out very generic and all accommodating, they can simply start out specific to the upcoming projects and then generalise as we need them for more and more projects.



### Imagined agents
We're probably going to figure out exactly what the agents we're going to have, but here are a few in my head so far:

| Agent               | Description
|--------------------   | --------------------------------------
| Idea Scout         | Scouts for ideas over the internet, public forums etc
| Idea Researcher      | Solidifies buildable ideas
| Idea reviewer      | Turn solidified ideas into potential business models
| Market Researcher      | Solidify business models
| Feasibility Judge      | Filter feasible business models
| Solution Architect      | Turns a business model into a tech product spec
| UX/UI Designer      | Creates UX/UI designs for the tech product
| Tech Architect      | High level architecture -> detailed tech spec
| Scaffolder         | Scaffolds the project and its structure thoroughly
| Integrators       | 3rd party integration specialists (supabase, stripe, etc)
| Coders            | Coding agents
| Test Spec Writer  | Agent that writes plain test specs (aiming to reduce reward hacking)
| Test Writers      | Agents turning plain test specs into executable tests as per code
| Reviewers      | Agents reviewing code and tests aginst project docs and specific perspectives
| Local DevOps Architect      | Local service containerisation and orchestration specialist
| Cloud DevOps Architect      | Cloud service orchestration, deployments and CI

I could imagine more agents like database specialist, pull request reviewer and whatnot, but we can figure those out together. Even the list I provide is just something I thought of at the top of my head. As you can guess, I'm hoping if I can have a agent team like a real time might look like, we may be able to set up a system so sophisticated, that leaves out no big drawbacks or painpoints.

The idea with this is clearly, to create a more controlled environment, and role based specialists so they are assigned based on their speciality depending on the stage of the work, and they just focus on doing one thing and one thing really well.


## Skills

Skills, of course, are amongst the most important components to focus on. Skills is how we'll define specialities, SOPs, and some typical workflows for high level agents like the PM and TL.

For this, we'd also like to take inspiration from communication skills marketplaces and meta frameworks like Superpowers, GSD, SpecKit etc, so we can pick and choose the ones that suit us the most, and customise as per our needs. We don't have to copy the whole sets from these, because their catalog can be quite broad and too generic. So, we'll take the necessary inspiration, take the necessary content and opinionate to our liking.

## Conclusion

I guess, this is all I have in mind so far. The next step is for you to ask any questions and get further clarity if needed, if you have any specific questions. Don't ask obvious and unnecessary questions for the same of it, but feel free if there are crucial questions that'll help dictate direction, scope, intent and whatnot.
Regardless, I'd like you to ingest this, ensure you understand what I'm talking about.
Then, let's create a high level outline/framework of how we're going to approach this. I assume there's going to be a lot of research needed to figure out the practices, what works well and what doesn't work well to dictates our decisions and clarify our assumptions here.

