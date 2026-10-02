import type { Project } from '$lib/projects/types';

export type TutorField = 'learnerName' | 'age' | 'subject' | 'level' | 'learningStyle' | 'tone' | 'language';

export interface TutorProfile {
  learnerName: string;
  age: string;
  subject: string;
  level: string;
  learningStyle: string;
  tone: string;
  language: string;
}

export interface TutorQuestion {
  field: TutorField;
  prompt: string;
  placeholder: string;
  choices?: string[];
}

export interface TutorLesson {
  title: string;
  objective: string;
  activity: string;
}

export interface TutorResearch {
  tutorName: string;
  welcome: string;
  approach: string;
  lessons: TutorLesson[];
  sources: string[];
}

export type TutorChatRole = 'learner' | 'tutor';

export interface TutorChatMessage {
  id: string;
  role: TutorChatRole;
  text: string;
}

export interface TutorChatReply {
  reply: string;
  progress: number;
}

export const TUTOR_PROJECT_MARKER = 'Created by Tutor Studio';
export const TUTOR_JOURNAL_MARKER = 'Tutor Room Learning Journal';
export const TUTOR_JOURNAL_NAME = 'Learning journal';

export const TUTOR_QUESTIONS: TutorQuestion[] = [
  {
    field: 'learnerName',
    prompt: 'Hi! What should your tutor call you?',
    placeholder: 'Your first name or nickname'
  },
  {
    field: 'age',
    prompt: 'How old are you?',
    placeholder: 'For example: 12'
  },
  {
    field: 'subject',
    prompt: 'What would you like to learn?',
    placeholder: 'For example: basic French or probabilities'
  },
  {
    field: 'level',
    prompt: 'What is your current level?',
    placeholder: 'Choose a level',
    choices: ['Complete beginner', 'I know the basics', 'Intermediate']
  },
  {
    field: 'learningStyle',
    prompt: 'How do you learn best?',
    placeholder: 'Choose a learning style',
    choices: ['Practical examples', 'Short games', 'Stories and analogies', 'Step-by-step exercises']
  },
  {
    field: 'tone',
    prompt: 'What kind of teacher would you like?',
    placeholder: 'Choose a personality',
    choices: ['Warm and encouraging', 'Calm and patient', 'Clear and direct']
  },
  {
    field: 'language',
    prompt: 'Which language should your tutor use?',
    placeholder: 'Choose a language',
    choices: ['English', 'French']
  }
];

const clean = (value: unknown, fallback: string, max = 700): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : fallback;
};

/** Extract the JSON object from a plain or fenced H answer. */
export function parseTutorResearch(answer: string, profile: TutorProfile): TutorResearch {
  const first = answer.indexOf('{');
  const last = answer.lastIndexOf('}');
  if (first < 0 || last <= first)
    throw new Error('H returned research, but not the requested curriculum format.');

  const raw = JSON.parse(answer.slice(first, last + 1)) as Record<string, unknown>;
  const lessonRows = Array.isArray(raw.lessons) ? raw.lessons : [];
  const lessons = lessonRows
    .slice(0, 3)
    .map((row, index): TutorLesson | null => {
      if (!row || typeof row !== 'object') return null;
      const lesson = row as Record<string, unknown>;
      return {
        title: clean(lesson.title, `Lesson ${index + 1}`, 120),
        objective: clean(lesson.objective, `Build confidence in ${profile.subject}.`),
        activity: clean(lesson.activity, 'Try a short guided exercise with your tutor.')
      };
    })
    .filter((lesson): lesson is TutorLesson => lesson !== null);

  if (!lessons.length) throw new Error('H returned research without any usable lessons.');

  while (lessons.length < 3) {
    const number = lessons.length + 1;
    lessons.push({
      title: `Practice ${number}`,
      objective: `Reinforce the previous ${profile.subject} lesson.`,
      activity: 'Review one example, then solve a similar challenge independently.'
    });
  }

  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .filter((source): source is string => typeof source === 'string')
    .map((source) => clean(source, '', 300))
    .filter(Boolean)
    .slice(0, 5);

  return {
    tutorName: clean(raw.tutorName, `${profile.learnerName}'s ${profile.subject} Tutor`, 120),
    welcome: clean(
      raw.welcome,
      `Hello ${profile.learnerName}! I am ready to help you learn ${profile.subject}.`
    ),
    approach: clean(
      raw.approach,
      `A ${profile.tone.toLowerCase()} tutor using ${profile.learningStyle.toLowerCase()}.`
    ),
    lessons,
    sources
  };
}

export function tutorProjectName(profile: TutorProfile): string {
  return `${profile.learnerName}'s ${profile.subject} Tutor`.slice(0, 200);
}

export function tutorProjectDescription(profile: TutorProfile, research: TutorResearch): string {
  return [
    TUTOR_PROJECT_MARKER,
    `${profile.age} years old · ${profile.level} · ${profile.language}`,
    `${profile.learningStyle} · ${profile.tone}`,
    research.approach
  ].join('\n');
}

export function lessonNote(lesson: TutorLesson, research: TutorResearch): string {
  const sourceBlock = research.sources.length
    ? `\n\nResearch sources:\n${research.sources.map((source) => `- ${source}`).join('\n')}`
    : '';
  return `Objective\n${lesson.objective}\n\nActivity\n${lesson.activity}${sourceBlock}`.slice(0, 2000);
}

export function isTutorProject(project: Pick<Project, 'description'>): boolean {
  return project.description?.startsWith(TUTOR_PROJECT_MARKER) ?? false;
}

export function buildTutorResearchInstruction(profile: TutorProfile): string {
  return `Research reliable, age-appropriate ways to teach ${profile.subject} to a ${profile.age}-year-old ${profile.level.toLowerCase()} learner. The learner prefers ${profile.learningStyle.toLowerCase()}. Create a safe three-lesson micro-course. Do not collect personal data. Return ONLY valid JSON with this exact shape and no markdown: {"tutorName":"short name","welcome":"two warm sentences in ${profile.language}","approach":"one sentence","lessons":[{"title":"...","objective":"...","activity":"..."},{"title":"...","objective":"...","activity":"..."},{"title":"...","objective":"...","activity":"..."}],"sources":["source title and URL"]}. The tutor must be ${profile.tone.toLowerCase()}, practical, factual, and suitable for the learner's age.`;
}

/** A compact H instruction: the provider contract accepts at most 2,000 characters. */
export function buildTutorChatInstruction(input: {
  projectId: string;
  projectName: string;
  projectDescription: string;
  lessons: Array<{ name: string; note: string }>;
  messages: TutorChatMessage[];
  progress: number;
}): string {
  const projectName = clean(input.projectName, 'Personalized tutor', 100);
  const projectDescription = clean(input.projectDescription, 'Supportive personalized tutor.', 220);
  const lessonContext = input.lessons
    .slice(0, 3)
    .map(
      (lesson, index) => `${index + 1}. ${clean(lesson.name, 'Lesson', 70)}: ${clean(lesson.note, '', 100)}`
    )
    .join('\n');
  const conversation = input.messages
    .slice(-4)
    .map((message) => `${message.role === 'learner' ? 'Student' : 'Tutor'}: ${clean(message.text, '', 100)}`)
    .join('\n');

  return clean(
    `[TUTOR_ROOM project=${input.projectId}] Act as the personalized tutor in "${projectName}". Profile: ${projectDescription}. Course:\n${lessonContext}\nConversation:\n${conversation}\nRespond to the student's latest message. Be age-appropriate, ${projectDescription.toLowerCase().includes('warm') ? 'warm and encouraging' : 'clear and supportive'}. Explain briefly, correct mistakes kindly, and usually end with exactly one useful question or exercise. Stay within this course; never request personal data. Return ONLY valid JSON, no markdown: {"reply":"2-5 short sentences","progress":${input.progress}}. progress must be an integer from ${input.progress} to 100 and should increase only when the student demonstrates learning.`,
    '',
    2000
  );
}

export function parseTutorChatReply(answer: string, fallbackProgress: number): TutorChatReply {
  const first = answer.indexOf('{');
  const last = answer.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      const raw = JSON.parse(answer.slice(first, last + 1)) as Record<string, unknown>;
      const reply = clean(raw.reply, '', 900);
      if (reply) {
        const proposed = typeof raw.progress === 'number' ? Math.round(raw.progress) : fallbackProgress;
        return { reply, progress: Math.max(fallbackProgress, Math.min(100, proposed)) };
      }
    } catch {
      // A useful plain-text H answer is still better than dropping the tutor turn.
    }
  }

  const reply = clean(answer.replace(/^```(?:json)?|```$/g, ''), '', 900);
  if (!reply) throw new Error('H completed the lesson without a usable tutor response.');
  return { reply, progress: fallbackProgress };
}

export function tutorWelcome(projectName: string, description: string): string {
  const learner = projectName.match(/^(.+?)(?:'s|’s)\s/i)?.[1] || 'there';
  const subject = projectName
    .replace(/^.+?(?:'s|’s)\s/i, '')
    .replace(/\s+Tutor$/i, '')
    .trim();
  const language = /\bFrench\b/i.test(description);
  if (language) {
    return `Bonjour ${learner} ! Je suis prêt à commencer notre cours de ${subject || 'ce sujet'}. Dis-moi ce que tu connais déjà, ou choisis la première leçon.`;
  }
  return `Hi ${learner}! I am ready to start our ${subject || 'first'} lesson. Tell me what you already know, or choose the first lesson below.`;
}

export function serializeTutorJournal(
  messages: TutorChatMessage[],
  progress: number,
  updatedAt: string
): string {
  const heading = `${TUTOR_JOURNAL_MARKER}\nProgress: ${Math.max(0, Math.min(100, Math.round(progress)))}%\nUpdated: ${updatedAt}\n\nConversation:\n`;
  const lines = messages.map(
    (message) => `${message.role === 'learner' ? 'Student' : 'Tutor'}: ${clean(message.text, '', 700)}`
  );

  while (lines.length && `${heading}${lines.join('\n')}`.length > 2000) lines.shift();
  return `${heading}${lines.join('\n')}`.slice(0, 2000);
}

export function parseTutorJournal(note: string): { messages: TutorChatMessage[]; progress: number } | null {
  if (!note.startsWith(TUTOR_JOURNAL_MARKER)) return null;
  const progress = Math.max(0, Math.min(100, Number(note.match(/^Progress:\s*(\d+)%/m)?.[1] ?? 0)));
  const conversation = note.split('\nConversation:\n')[1] ?? '';
  const messages = conversation
    .split('\n')
    .map((line, index): TutorChatMessage | null => {
      const match = line.match(/^(Student|Tutor):\s*(.+)$/);
      if (!match) return null;
      return {
        id: `saved-${index}`,
        role: match[1] === 'Student' ? 'learner' : 'tutor',
        text: match[2]
      };
    })
    .filter((message): message is TutorChatMessage => message !== null);
  return { messages, progress };
}
