import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";

export const TodoStatusSchema = StringEnum(["pending", "in_progress", "completed"] as const);

export const TodoItemSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, description: "Imperative task description, e.g. 'Run tests'" }),
		status: TodoStatusSchema,
		activeForm: Type.String({ minLength: 1, description: "Present-continuous form, e.g. 'Running tests'" }),
	},
	{ additionalProperties: false },
);

export const TodoWriteParamsSchema = Type.Object(
	{
		todos: Type.Array(TodoItemSchema, { description: "The updated todo list for the current Pi session" }),
	},
	{ additionalProperties: false },
);

export const TaskCreateParamsSchema = Type.Object(
	{
		subject: Type.String({ minLength: 1, description: "Concise task title" }),
		description: Type.String({ minLength: 1, description: "Full task details" }),
		activeForm: Type.Optional(Type.String({ minLength: 1, description: "Present-continuous form, e.g. 'Adding tests'" })),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional task metadata" })),
	},
	{ additionalProperties: false },
);

export const TaskUpdateParamsSchema = Type.Object(
	{
		taskId: Type.String({ minLength: 1, description: "Task ID to update" }),
		subject: Type.Optional(Type.String({ minLength: 1 })),
		description: Type.Optional(Type.String({ minLength: 1 })),
		activeForm: Type.Optional(Type.String({ minLength: 1 })),
		status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
		addBlocks: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Task IDs blocked by this task" })),
		addBlockedBy: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Task IDs that block this task" })),
		owner: Type.Optional(Type.String({ minLength: 1 })),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge; null deletes a key" })),
	},
	{ additionalProperties: false },
);

export const TaskGetParamsSchema = Type.Object(
	{
		taskId: Type.String({ minLength: 1, description: "Task ID to retrieve" }),
	},
	{ additionalProperties: false },
);

export const TaskListParamsSchema = Type.Object({}, { additionalProperties: false });

export type TodoWriteParams = Static<typeof TodoWriteParamsSchema>;
export type TaskCreateParams = Static<typeof TaskCreateParamsSchema>;
export type TaskUpdateParams = Static<typeof TaskUpdateParamsSchema>;
export type TaskGetParams = Static<typeof TaskGetParamsSchema>;
export type TaskListParams = Static<typeof TaskListParamsSchema>;
