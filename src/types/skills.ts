export interface SkillRef {
  name: string;
  builtin?: boolean;
}

export interface SkillSummary {
  name: string;
  displayName: string;
  description?: string;
  enabled?: boolean;
}

export interface SkillChatStart {
  kind?: string;
  name?: string;
  displayName?: string;
  skill?: SkillSummary;
  draft?: {
    title?: string;
    description?: string;
    instructions?: string;
    example?: string;
    fileNames?: string[];
  };
}

export interface SkillChatRequest extends SkillChatStart {
  id: number;
}
