---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
allowed-tools: ask_user_question
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

When asking a question, use the `ask_user_question` tool to present the question and its options to the user. Formulate clear, structured options for the user to choose from, providing descriptions or previews as appropriate.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.