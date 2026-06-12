# FactScroll App

## Project Idea: 

A webapp similar to Instagram Reels but featuring interesting, AI-generated facts/factoids on scrollable screens, paired with contextually fitting background images instead of short videos.



## Requirements

* The app has 3 primary tabs: facts, news, preferences
* Both facts and news screens are scrollable like instagram reels or youtube shorts, preferences page is for managing interests for now
* Interests are determined during user onboarding, and can be managed from preferences page anytime
* To determine interests, the app uses wider -> narrower strategy like apps like spotify/google-news do to understand genres or fields. Imagine bubbles showing very high level classifications like tech, science, business, religion, finance etc, and as you select, slightly smaller bubbles with their further subdivisions open up and this goes on until user is done and saves it.
* Facts screen frontloads a 3-5 ai-generated facts, and as the user scrolls maintains a 3 slides buffer so the user never has to scroll to an empty slide and wait for generation to happen.
* News screen behaves in the same way, the only difference between facts and news is that the facts are purely ai creations and aren't necessarily contemporary. News on the other hand, is well, news, it requires web search grounding and recency relevancy.
* Use unsplash to get a stock photo to provide a relevant and aesthetic background image for each slide.
* Facts/news card/screen also has other controls like like, dislike, comment, share buttons.
* Like, dislike, comment actions are for further opinionating the generated content to cater to the user. These likes and dislikes should play a role in further recommendations/generations etc.
* The previous generated screens should be persisted as part of localstorage, so it doesn't get cleared up on refreshes and I should be able to scrollback. Additionally, these should be searchable, if I try to remember something I saw a while back, and search for something, it should navigate to another page with the search results with the option to get back to the scrolling screen.
* This is for my personal use, so no need for multi-user considerations (for now).

