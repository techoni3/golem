---
name: night-shift
description: Use this when asked to go on a night-shift; when the user is stepping away for the night and won't be available for hand holding.
---
<!-- GENERATED: skills/night-shift/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

I'm going away for the night, and you have to work autonomously to complete the work that we've planned.
I won't be available to answer any of your questions, or unblock you on any permission prompts.
DO NOT get stuck asking for permission prompts, or other questions. For instance, trying to access outside the repo dir, will most likely get you blocked on permission prompts, same goes for delegated agent pool.

Create a loop/cron to wake yourself up every 15 mins to ensure that you don't go sleep/idle.

Keep an eye on the agents/builders/explorers in case they get stuck, and don't respond for a long time, your loop wake should help realise in case an agent gets stuck for long.
If an agent can't recover:
* try to send it to another agent of the same role if available
* if no agent of the same role available, but other agents of lower tier are available, send them (planner > manager > builder > explorer). Builder work can be sent to explorer but not to manager or planner.
* If no viable agent session is available, and the work is pending, create one or more agents yourself in your session with the similar roles/responsibilities that you'd need for that work.

If there's anything you need from me, right now is the time...I won't be available later.
