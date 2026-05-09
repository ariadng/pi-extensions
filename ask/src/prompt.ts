export const ASK_USER_QUESTION_DESCRIPTION = `Ask the user one or more structured multiple-choice questions during execution.

Use AskUserQuestion when you need user preferences, clarification, requirements, ambiguity resolution, implementation decisions, or direction choices before proceeding. Provide 1-4 concrete questions. Each question must have 2-4 concrete options. The UI automatically offers a custom free-text option, so do not include an explicit Other option.

For each question, include a short header for navigation, concise option labels, and descriptions that explain trade-offs. Put the recommended option first and include "(Recommended)" in its label when one choice is preferred. Use multiSelect only when multiple answers can apply.

Do not use AskUserQuestion for trivial questions that can be answered by inspecting files, running commands, or making a reasonable default choice. Do not use AskUserQuestion for final plan approval.`;

export const ASK_USER_QUESTION_PROMPT_SNIPPET = "Ask the user one or more multiple-choice questions during execution.";

export const ASK_USER_QUESTION_PROMPT_GUIDELINES = [
	"Use AskUserQuestion when you need user preferences, clarification, or a decision before proceeding.",
	"AskUserQuestion questions must be concrete and answerable with the provided options; avoid asking for plan approval.",
	"AskUserQuestion automatically offers Other/custom text, so do not add an Other option yourself.",
	"AskUserQuestion supports multiSelect for non-exclusive choices; use it only when multiple answers can apply.",
	"AskUserQuestion should put the recommended option first and include (Recommended) in the label when one choice is preferred.",
	"AskUserQuestion should not be used for trivial questions that can be answered by inspecting the repository or environment.",
];
