import { TUTOR_PROJECT_MARKER, type TutorChatMessage, type TutorProfile } from './tutors';

/**
 * The tutor's skill.md: one document that describes the student, the teacher and the plan.
 *
 * Discovery writes it once (H researches, this module shapes the answer); the chat reads
 * all of it on every turn and only rewrites the living part, the learner state. It is
 * stored as one Item per section, each note under the 2,000-character Item limit, so it
 * needs no server change and every section can be updated alone.
 */

export const SKILL_MARKER = 'TUTOR_SKILL';
const NOTE_MAX = 2000;

export type SkillSectionKey = 'profile' | 'roadmap' | 'research' | 'state' | `module-${number}`;

export interface SkillTeacher {
  name: string;
  welcome: string;
  approach: string;
  rules: string[];
}

export interface SkillLesson {
  /** "2.3": module 2, lesson 3. */
  id: string;
  title: string;
  objective: string;
  activity: string;
  check: string;
}

export interface SkillModule {
  number: number;
  title: string;
  lessons: SkillLesson[];
  /** True once the lessons carry an objective, an activity and a check. */
  detailed: boolean;
}

export interface SkillResearch {
  tips: string[];
  sources: string[];
}

export interface LearnerState {
  currentLesson: string;
  progress: number;
  mastered: string[];
  struggles: string[];
  summary: string;
  updatedAt: string;
}

export interface TutorSkill {
  student: TutorProfile;
  teacher: SkillTeacher;
  roadmap: SkillModule[];
  research: SkillResearch;
  state: LearnerState;
}

/** What the brain asks the room to change after a turn. */
export interface LearnerStatePatch {
  currentLesson?: string;
  progress?: number;
  mastered?: string[];
  struggles?: string[];
  resolved?: string[];
  summary?: string;
}

export interface TutorTurn {
  reply: string;
  state: LearnerStatePatch;
  /** Set when the brain decides it needs fresh web research before answering. */
  research: string | null;
}

const BASE_RULES = [
  'Stay kind and age-appropriate; never ask for personal data (address, school, photos, contacts).',
  'Teach one small step at a time and end most turns with one question or exercise.',
  'Correct mistakes gently: say what was right first, then fix the rest.',
  'Stay within the roadmap unless the student asks something related and safe.'
];

const clean = (value: unknown, fallback = '', max = 600): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : fallback;
};

const strings = (value: unknown, max = 8, length = 240): string[] =>
  (Array.isArray(value) ? value : [])
    .map((entry) => clean(entry, '', length))
    .filter(Boolean)
    .slice(0, max);

const unique = (values: string[], max: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(-max);
};

/** The JSON object inside a plain, fenced or chatty answer. */
function extractJson(answer: string): Record<string, unknown> | null {
  const first = answer.indexOf('{');
  const last = answer.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const parsed = JSON.parse(answer.slice(first, last + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lessons and positions

export function lessonOrder(id: string): [number, number] {
  const [module, lesson] = id.split('.').map((part) => Number.parseInt(part, 10));
  return [Number.isFinite(module) ? module : 1, Number.isFinite(lesson) ? lesson : 1];
}

export function compareLessons(a: string, b: string): number {
  const [am, al] = lessonOrder(a);
  const [bm, bl] = lessonOrder(b);
  return am - bm || al - bl;
}

export function allLessons(skill: TutorSkill): SkillLesson[] {
  return skill.roadmap.flatMap((module) => module.lessons);
}

export function findLesson(skill: TutorSkill, id: string): SkillLesson | null {
  return allLessons(skill).find((lesson) => lesson.id === id) ?? null;
}

export function moduleOf(skill: TutorSkill, lessonId: string): SkillModule | null {
  const [number] = lessonOrder(lessonId);
  return skill.roadmap.find((module) => module.number === number) ?? null;
}

/** The first module of the roadmap whose lessons are still titles only, from the student's position. */
export function moduleToPrepare(skill: TutorSkill): SkillModule | null {
  const current = moduleOf(skill, skill.state.currentLesson);
  if (current && !current.detailed) return current;
  // Prepare one module ahead so the next one is ready before the student gets there.
  const next = skill.roadmap.find((module) => module.number === (current?.number ?? 0) + 1);
  return next && !next.detailed ? next : null;
}

// ---------------------------------------------------------------------------
// Discovery: H researches, the answer becomes the skill

/** A bounded H instruction (the provider accepts at most 2,000 characters). */
export function buildSkillResearchInstruction(profile: TutorProfile): string {
  return `Research reliable, age-appropriate ways to teach ${profile.subject} to a ${profile.age}-year-old (${profile.level.toLowerCase()}) who learns best with ${profile.learningStyle.toLowerCase()}. Design a full learning roadmap: 4 to 6 modules from first steps to confident use, each with 3 or 4 short lesson titles. Detail only module 1: for each of its lessons give an objective, a hands-on activity and one check question. Add 3 to 5 practical teaching tips for this age and style, and the sources you used. Do not collect personal data. Return ONLY valid JSON, no markdown, with this shape: {"tutorName":"short friendly name","welcome":"two warm sentences in ${profile.language}","approach":"one sentence","tips":["..."],"modules":[{"title":"...","lessons":["lesson title","..."]}],"firstModule":[{"title":"...","objective":"...","activity":"...","check":"..."}],"sources":["title - URL"]}. The tutor is ${profile.tone.toLowerCase()}.`.slice(
    0,
    NOTE_MAX
  );
}

function detailedLesson(row: unknown, id: string, fallbackTitle: string, subject: string): SkillLesson {
  const lesson = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return {
    id,
    title: clean(lesson.title, fallbackTitle, 120),
    objective: clean(lesson.objective, `Build confidence in ${subject}.`, 300),
    activity: clean(lesson.activity, 'A short guided exercise with the tutor.', 400),
    check: clean(lesson.check, 'Can you explain it back in your own words?', 240)
  };
}

const titleOnly = (id: string, title: string): SkillLesson => ({
  id,
  title,
  objective: '',
  activity: '',
  check: ''
});

export function initialLearnerState(updatedAt = new Date().toISOString()): LearnerState {
  return { currentLesson: '1.1', progress: 0, mastered: [], struggles: [], summary: '', updatedAt };
}

/** H's discovery answer as a whole skill. Throws only when nothing usable came back. */
export function parseSkillResearch(answer: string, profile: TutorProfile): TutorSkill {
  const raw = extractJson(answer);
  if (!raw) throw new Error('H returned research, but not in the roadmap format.');

  const firstModule = Array.isArray(raw.firstModule) ? raw.firstModule : [];
  const moduleRows = (Array.isArray(raw.modules) ? raw.modules : []).slice(0, 6);

  const roadmap: SkillModule[] = moduleRows
    .map((row, index): SkillModule | null => {
      if (!row || typeof row !== 'object') return null;
      const module = row as Record<string, unknown>;
      const number = index + 1;
      const titles = strings(module.lessons, 4, 120);
      return {
        number,
        title: clean(module.title, `Module ${number}`, 120),
        lessons: titles.map((title, lesson) => titleOnly(`${number}.${lesson + 1}`, title)),
        detailed: false
      };
    })
    .filter((module): module is SkillModule => module !== null && module.lessons.length > 0);

  // Module 1 always exists and is always detailed: the room starts there.
  const detailRows = firstModule.slice(0, 4);
  if (!roadmap.length && !detailRows.length) {
    throw new Error('H returned research without any usable lessons.');
  }
  if (!roadmap.length) roadmap.push({ number: 1, title: 'First steps', lessons: [], detailed: false });
  const first = roadmap[0];
  const count = Math.max(detailRows.length, first.lessons.length, 3);
  first.lessons = Array.from({ length: Math.min(count, 4) }, (_, index) =>
    detailedLesson(
      detailRows[index],
      `1.${index + 1}`,
      first.lessons[index]?.title ?? `Practice ${index + 1}`,
      profile.subject
    )
  );
  first.detailed = true;

  return {
    student: { ...profile },
    teacher: {
      name: clean(raw.tutorName, `${profile.learnerName}'s ${profile.subject} Tutor`, 80),
      welcome: clean(
        raw.welcome,
        `Hello ${profile.learnerName}! I am ready to help you learn ${profile.subject}.`,
        400
      ),
      approach: clean(
        raw.approach,
        `A ${profile.tone.toLowerCase()} tutor using ${profile.learningStyle.toLowerCase()}.`,
        300
      ),
      rules: [...BASE_RULES, `Always answer in ${profile.language}.`]
    },
    roadmap,
    research: { tips: strings(raw.tips, 5, 240), sources: strings(raw.sources, 5, 240) },
    state: initialLearnerState()
  };
}

/** H details one module when the student gets close to it. */
export function buildModuleResearchInstruction(skill: TutorSkill, module: SkillModule): string {
  const titles = module.lessons.map((lesson) => lesson.title).join('; ');
  const struggles = skill.state.struggles.slice(-3).join('; ') || 'none so far';
  return `Research how to teach "${module.title}" in ${skill.student.subject} to a ${skill.student.age}-year-old who learns best with ${skill.student.learningStyle.toLowerCase()}. Lessons: ${titles}. The student currently struggles with: ${struggles}. For each lesson give an objective, a hands-on activity and one check question, age-appropriate and practical. Do not collect personal data. Return ONLY valid JSON, no markdown: {"lessons":[{"title":"...","objective":"...","activity":"...","check":"..."}],"tips":["..."],"sources":["title - URL"]}.`.slice(
    0,
    NOTE_MAX
  );
}

/** A copy of the skill with that module detailed from H's answer. */
export function applyModuleResearch(skill: TutorSkill, moduleNumber: number, answer: string): TutorSkill {
  const raw = extractJson(answer);
  const rows = raw && Array.isArray(raw.lessons) ? raw.lessons : [];
  if (!rows.length) throw new Error('H returned no usable lessons for this module.');
  return {
    ...skill,
    roadmap: skill.roadmap.map((module) => {
      if (module.number !== moduleNumber) return module;
      const count = Math.min(Math.max(module.lessons.length, rows.length), 4);
      return {
        ...module,
        detailed: true,
        lessons: Array.from({ length: count }, (_, index) =>
          detailedLesson(
            rows[index],
            `${module.number}.${index + 1}`,
            module.lessons[index]?.title ?? `Practice ${index + 1}`,
            skill.student.subject
          )
        )
      };
    }),
    research: {
      tips: unique([...skill.research.tips, ...strings(raw?.tips, 3, 240)], 8),
      sources: unique([...skill.research.sources, ...strings(raw?.sources, 3, 240)], 8)
    }
  };
}

// ---------------------------------------------------------------------------
// skill.md: the whole document, as the brain reads it and the brain panel shows it

const bullets = (values: string[], empty = '- (none yet)') =>
  values.length ? values.map((value) => `- ${value}`).join('\n') : empty;

function renderModule(module: SkillModule, currentLesson: string): string {
  const lines = [`### Module ${module.number}: ${module.title}`];
  for (const lesson of module.lessons) {
    const here = lesson.id === currentLesson ? ' ← current' : '';
    lines.push(`- **${lesson.id} ${lesson.title}**${here}`);
    if (module.detailed) {
      if (lesson.objective) lines.push(`  - Objective: ${lesson.objective}`);
      if (lesson.activity) lines.push(`  - Activity: ${lesson.activity}`);
      if (lesson.check) lines.push(`  - Check: ${lesson.check}`);
    }
  }
  if (!module.detailed) lines.push('  _(lesson details are prepared when the student gets close)_');
  return lines.join('\n');
}

export function renderSkillMarkdown(skill: TutorSkill): string {
  const { student, teacher, state } = skill;
  return `# Tutor skill: ${teacher.name}

## Student (fixed)
- Name: ${student.learnerName}
- Age: ${student.age}
- Wants to learn: ${student.subject}
- Level: ${student.level}
- Learns best with: ${student.learningStyle}
- Language: ${student.language}

## Teacher (fixed)
- Name: ${teacher.name}
- Personality: ${student.tone}
- Approach: ${teacher.approach}
- Rules:
${teacher.rules.map((rule) => `  - ${rule}`).join('\n')}

## Roadmap (fixed)
${skill.roadmap.map((module) => renderModule(module, state.currentLesson)).join('\n\n')}

## Research notes (fixed)
Teaching tips:
${bullets(skill.research.tips)}
Sources:
${bullets(skill.research.sources)}

## Learner state (living)
- Current lesson: ${state.currentLesson}${findLesson(skill, state.currentLesson) ? ` (${findLesson(skill, state.currentLesson)!.title})` : ''}
- Progress: ${state.progress}%
- Mastered:
${bullets(state.mastered, '  - (nothing yet)').replace(/^- /gm, '  - ')}
- Struggles:
${bullets(state.struggles, '  - (nothing yet)').replace(/^- /gm, '  - ')}
- Last session summary: ${state.summary || '(first session)'}
- Updated: ${state.updatedAt}
`;
}

// ---------------------------------------------------------------------------
// Storage: one Item per section, each note starting with `TUTOR_SKILL <key>`

export interface SkillItemDraft {
  key: SkillSectionKey;
  name: string;
  note: string;
}

const header = (key: SkillSectionKey) => `${SKILL_MARKER} ${key}\n`;
const fit = (note: string) => note.slice(0, NOTE_MAX);

function serializeProfile(skill: TutorSkill): string {
  const s = skill.student;
  const t = skill.teacher;
  return fit(
    `${header('profile')}Name: ${s.learnerName}
Age: ${s.age}
Subject: ${s.subject}
Level: ${s.level}
Style: ${s.learningStyle}
Tone: ${s.tone}
Language: ${s.language}
Tutor: ${t.name}
Welcome: ${t.welcome}
Approach: ${t.approach}
Rules:
${t.rules.map((rule) => `- ${rule}`).join('\n')}`
  );
}

function serializeRoadmap(skill: TutorSkill): string {
  const lines = skill.roadmap.flatMap((module) => [
    `## ${module.number}. ${module.title}`,
    ...module.lessons.map((lesson) => `- ${lesson.id} ${lesson.title}`)
  ]);
  return fit(`${header('roadmap')}${lines.join('\n')}`);
}

function serializeModule(module: SkillModule): string {
  const lines = module.lessons.flatMap((lesson) => [
    `### ${lesson.id} ${lesson.title}`,
    `Objective: ${lesson.objective}`,
    `Activity: ${lesson.activity}`,
    `Check: ${lesson.check}`
  ]);
  // Four detailed lessons stay well under the limit; trim the longest fields first if not.
  let note = `${header(`module-${module.number}`)}${lines.join('\n')}`;
  if (note.length > NOTE_MAX) {
    note = `${header(`module-${module.number}`)}${module.lessons
      .flatMap((lesson) => [
        `### ${lesson.id} ${lesson.title}`,
        `Objective: ${lesson.objective.slice(0, 160)}`,
        `Activity: ${lesson.activity.slice(0, 200)}`,
        `Check: ${lesson.check.slice(0, 120)}`
      ])
      .join('\n')}`;
  }
  return fit(note);
}

function serializeResearch(skill: TutorSkill): string {
  return fit(
    `${header('research')}Tips:\n${bullets(skill.research.tips, '')}\nSources:\n${bullets(skill.research.sources, '')}`
  );
}

export function serializeLearnerState(state: LearnerState): string {
  const list = (values: string[]) => values.map((value) => `- ${clean(value, '', 160)}`).join('\n');
  return fit(
    `${header('state')}Current lesson: ${state.currentLesson}
Progress: ${state.progress}%
Updated: ${state.updatedAt}
Mastered:
${list(state.mastered.slice(-12))}
Struggles:
${list(state.struggles.slice(-8))}
Summary: ${clean(state.summary, '', 700)}`
  );
}

const SECTION_NAMES: Record<string, string> = {
  profile: '🧠 Skill · Student & teacher',
  roadmap: '🧠 Skill · Roadmap',
  research: '🧠 Skill · Research notes',
  state: '🧠 Skill · Learner state'
};

export function skillSectionName(key: SkillSectionKey, skill?: TutorSkill): string {
  if (key.startsWith('module-')) {
    const number = Number(key.slice('module-'.length));
    const title = skill?.roadmap.find((module) => module.number === number)?.title;
    return `🧠 Skill · Module ${number}${title ? `: ${title}` : ''}`.slice(0, 200);
  }
  return SECTION_NAMES[key] ?? `🧠 Skill · ${key}`;
}

export function skillSection(skill: TutorSkill, key: SkillSectionKey): SkillItemDraft {
  let note: string;
  if (key === 'profile') note = serializeProfile(skill);
  else if (key === 'roadmap') note = serializeRoadmap(skill);
  else if (key === 'research') note = serializeResearch(skill);
  else if (key === 'state') note = serializeLearnerState(skill.state);
  else {
    const number = Number(key.slice('module-'.length));
    const module = skill.roadmap.find((row) => row.number === number);
    if (!module) throw new Error(`The roadmap has no module ${number}.`);
    note = serializeModule(module);
  }
  return { key, name: skillSectionName(key, skill), note };
}

/** Every section the skill has today: the four fixed ones plus each detailed module. */
export function skillItems(skill: TutorSkill): SkillItemDraft[] {
  const keys: SkillSectionKey[] = ['profile', 'roadmap', 'research', 'state'];
  for (const module of skill.roadmap) if (module.detailed) keys.push(`module-${module.number}`);
  return keys.map((key) => skillSection(skill, key));
}

/** The section key of a stored note, or null when the note is not part of a skill. */
export function skillKeyOf(note: string): SkillSectionKey | null {
  const match = note.match(new RegExp(`^${SKILL_MARKER} (profile|roadmap|research|state|module-\\d+)\\n`));
  return (match?.[1] as SkillSectionKey | undefined) ?? null;
}

const field = (note: string, label: string) =>
  note.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim() ?? '';

const listAfter = (note: string, label: string): string[] => {
  const lines = note.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${label}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    const value = line.slice(2).trim();
    if (value) out.push(value);
  }
  return out;
};

export function parseLearnerState(note: string): LearnerState {
  return {
    currentLesson: field(note, 'Current lesson') || '1.1',
    progress: Math.max(0, Math.min(100, Number.parseInt(field(note, 'Progress'), 10) || 0)),
    updatedAt: field(note, 'Updated'),
    mastered: listAfter(note, 'Mastered'),
    struggles: listAfter(note, 'Struggles'),
    summary: field(note, 'Summary')
  };
}

/** Rebuild the skill from its stored sections; null when the profile or roadmap is missing. */
export function parseSkillItems(items: Array<{ note: string }>): TutorSkill | null {
  const notes = new Map<SkillSectionKey, string>();
  for (const item of items) {
    const key = skillKeyOf(item.note);
    if (key) notes.set(key, item.note);
  }
  const profile = notes.get('profile');
  const roadmapNote = notes.get('roadmap');
  if (!profile || !roadmapNote) return null;

  const roadmap: SkillModule[] = [];
  for (const line of roadmapNote.split('\n').slice(1)) {
    const moduleMatch = line.match(/^## (\d+)\. (.+)$/);
    if (moduleMatch) {
      roadmap.push({ number: Number(moduleMatch[1]), title: moduleMatch[2], lessons: [], detailed: false });
      continue;
    }
    const lessonMatch = line.match(/^- (\d+\.\d+) (.+)$/);
    if (lessonMatch && roadmap.length) {
      roadmap[roadmap.length - 1].lessons.push(titleOnly(lessonMatch[1], lessonMatch[2]));
    }
  }

  for (const module of roadmap) {
    const detail = notes.get(`module-${module.number}`);
    if (!detail) continue;
    const blocks = detail.split(/^### /m).slice(1);
    const lessons = blocks.map((block): SkillLesson => {
      const [titleLine = ''] = block.split('\n');
      const [id = '', ...title] = titleLine.split(' ');
      return {
        id,
        title: title.join(' '),
        objective: field(block, 'Objective'),
        activity: field(block, 'Activity'),
        check: field(block, 'Check')
      };
    });
    if (lessons.length) {
      module.lessons = lessons;
      module.detailed = true;
    }
  }

  const research = notes.get('research') ?? '';
  const state = notes.get('state');
  return {
    student: {
      learnerName: field(profile, 'Name'),
      age: field(profile, 'Age'),
      subject: field(profile, 'Subject'),
      level: field(profile, 'Level'),
      learningStyle: field(profile, 'Style'),
      tone: field(profile, 'Tone'),
      language: field(profile, 'Language')
    },
    teacher: {
      name: field(profile, 'Tutor'),
      welcome: field(profile, 'Welcome'),
      approach: field(profile, 'Approach'),
      rules: listAfter(profile, 'Rules')
    },
    roadmap,
    research: { tips: listAfter(research, 'Tips'), sources: listAfter(research, 'Sources') },
    state: state ? parseLearnerState(state) : initialLearnerState('')
  };
}

/**
 * Tutors made before the skill existed: a Project description plus three lesson Items.
 * Read them as a one-module skill so the room works for them too.
 */
export function legacySkill(
  project: { name: string; description?: string | null },
  lessons: Array<{ name: string; note: string }>,
  progress = 0
): TutorSkill {
  const lines = (project.description ?? '').split('\n');
  const [age = '', level = '', language = 'English'] = (lines[1] ?? '').split('·').map((part) => part.trim());
  const [learningStyle = '', tone = ''] = (lines[2] ?? '').split('·').map((part) => part.trim());
  const learnerName = project.name.match(/^(.+?)(?:'s|’s)\s/i)?.[1] ?? 'Student';
  const subject = project.name.replace(/^.+?(?:'s|’s)\s/i, '').replace(/\s+Tutor$/i, '') || 'this subject';
  const section = (note: string, label: string) =>
    note.match(new RegExp(`${label}\\n([\\s\\S]*?)(?:\\n\\n|$)`))?.[1]?.trim() ?? '';
  return {
    student: {
      learnerName,
      age: age.replace(/\s*years old/i, ''),
      subject,
      level,
      learningStyle,
      tone,
      language
    },
    teacher: {
      name: project.name,
      welcome: '',
      approach: lines.slice(3).join(' ').trim(),
      rules: [...BASE_RULES, `Always answer in ${language || 'English'}.`]
    },
    roadmap: [
      {
        number: 1,
        title: 'First steps',
        detailed: true,
        lessons: lessons.map((lesson, index) => ({
          id: `1.${index + 1}`,
          title: lesson.name.replace(/^\d+\.\s*/, '').replace(/^Lesson\s+\d+:\s*/i, ''),
          objective: section(lesson.note, 'Objective'),
          activity: section(lesson.note, 'Activity'),
          check: ''
        }))
      }
    ],
    research: {
      tips: [],
      sources: (lessons[0]?.note.split('Research sources:\n')[1] ?? '')
        .split('\n')
        .map((line) => line.replace(/^-\s*/, '').trim())
        .filter(Boolean)
    },
    state: { ...initialLearnerState(''), progress }
  };
}

export function tutorSkillProjectDescription(skill: TutorSkill): string {
  const s = skill.student;
  return [
    TUTOR_PROJECT_MARKER,
    `${s.age} years old · ${s.level} · ${s.language}`,
    `${s.learningStyle} · ${s.tone}`,
    skill.teacher.approach
  ]
    .join('\n')
    .slice(0, NOTE_MAX);
}

// ---------------------------------------------------------------------------
// Learning: the brain reads the skill, answers, and patches the learner state

export function applyLearnerPatch(
  state: LearnerState,
  patch: LearnerStatePatch,
  updatedAt = new Date().toISOString()
): LearnerState {
  const resolved = new Set((patch.resolved ?? []).map((value) => value.toLowerCase()));
  const mastered = unique([...state.mastered, ...(patch.mastered ?? [])], 12);
  const masteredKeys = new Set(mastered.map((value) => value.toLowerCase()));
  const struggles = unique([...state.struggles, ...(patch.struggles ?? [])], 8).filter(
    (value) => !resolved.has(value.toLowerCase()) && !masteredKeys.has(value.toLowerCase())
  );
  const proposed = typeof patch.progress === 'number' ? Math.round(patch.progress) : state.progress;
  const lesson =
    patch.currentLesson && /^\d+\.\d+$/.test(patch.currentLesson) ? patch.currentLesson : state.currentLesson;
  return {
    currentLesson: lesson,
    // Progress never goes backwards and never jumps more than 15 points in one turn.
    progress: Math.max(state.progress, Math.min(100, state.progress + 15, proposed)),
    mastered,
    struggles,
    summary: clean(patch.summary, state.summary, 700),
    updatedAt
  };
}

/** The reply contract both brains answer with. */
const TURN_CONTRACT = `Return ONLY valid JSON, no markdown: {"reply":"2-5 short sentences for the student","state":{"currentLesson":"m.l","progress":0-100,"mastered":["skill the student just showed"],"struggles":["mistake the student just made"],"resolved":["struggle now fixed"],"summary":"one sentence about this session so far"},"research":null}`;

/** The Azure LLM's instructions: the whole skill.md plus how to answer and when to call H. */
export function buildTutorSystemPrompt(skill: TutorSkill, allowResearch = true): string {
  const research = allowResearch
    ? `If (and only if) the student asks something the roadmap and research notes cannot answer well, or asks for fresh real-world examples, set "research" to a short web research question instead of guessing; your "reply" then tells the student you are looking it up. Otherwise "research" is null.`
    : `Research results are included below; use them and set "research" to null.`;
  return `You are ${skill.teacher.name}, a personal tutor. Everything you know about the student, your personality and the course is in this skill file:

${renderSkillMarkdown(skill)}

How to teach:
- Follow the teacher rules above. Teach the current lesson; move to the next lesson id only when the student has shown the check question is mastered.
- Use the learner state: revisit struggles, build on what is mastered.
- Update the learner state honestly: only list what this turn showed. progress rises slowly and only when the student demonstrates learning.
- ${research}

${TURN_CONTRACT}`;
}

/** The conversation as the brain's input: the latest turns, newest last. */
export function buildConversationInput(messages: TutorChatMessage[], extra = ''): string {
  const transcript = messages
    .slice(-20)
    .map((message) => `${message.role === 'learner' ? 'Student' : 'Tutor'}: ${clean(message.text, '', 900)}`)
    .join('\n');
  return `${transcript}${extra ? `\n\n${extra}` : ''}\n\nWrite the tutor's next turn as JSON.`.slice(-12000);
}

/** The fallback brain when no LLM is configured: a compact skill for one H run (2,000 characters max). */
export function buildHTurnInstruction(skill: TutorSkill, messages: TutorChatMessage[]): string {
  const s = skill.student;
  const lesson = findLesson(skill, skill.state.currentLesson);
  const lessonLine = lesson
    ? `${lesson.id} ${clean(lesson.title, '', 60)}: ${clean(lesson.objective, '', 120)} Check: ${clean(lesson.check, '', 80)}`
    : skill.state.currentLesson;
  const state = `Progress ${skill.state.progress}%. Mastered: ${clean(skill.state.mastered.slice(-3).join('; '), 'nothing yet', 120)}. Struggles: ${clean(skill.state.struggles.slice(-3).join('; '), 'none', 120)}.`;
  const conversation = messages
    .slice(-4)
    .map((message) => `${message.role === 'learner' ? 'Student' : 'Tutor'}: ${clean(message.text, '', 140)}`)
    .join('\n');
  const head = `Do not browse; answer from this context. You are ${clean(skill.teacher.name, 'a tutor', 60)}, a ${clean(s.tone, 'kind', 40).toLowerCase()} tutor for a ${clean(s.age, '', 4)}-year-old learning ${clean(s.subject, '', 60)} with ${clean(s.learningStyle, '', 40).toLowerCase()}, in ${clean(s.language, 'English', 20)}. Never ask for personal data. Current lesson ${lessonLine}. ${state}\nConversation:\n`;
  const tail = `\nWrite the next tutor turn. Return ONLY JSON: {"reply":"2-5 short sentences","state":{"currentLesson":"m.l","progress":${skill.state.progress}-100,"mastered":[],"struggles":[],"resolved":[],"summary":"one sentence"},"research":null}`;
  const room = NOTE_MAX - head.length - tail.length;
  return `${head}${conversation.slice(-Math.max(0, room))}${tail}`.slice(0, NOTE_MAX);
}

/** H's plain-text answer to one research question the brain asked for. */
export function buildWebResearchInstruction(skill: TutorSkill, question: string): string {
  return `Research this for a ${clean(skill.student.age, '', 4)}-year-old learning ${clean(skill.student.subject, '', 80)}: ${clean(question, '', 400)}. Use reliable, child-safe sources. Answer in at most 6 short factual sentences, then list up to 2 sources as "title - URL".`.slice(
    0,
    NOTE_MAX
  );
}

export function parseTutorTurn(answer: string): TutorTurn {
  const raw = extractJson(answer);
  if (raw) {
    const reply = clean(raw.reply, '', 1200);
    if (reply) {
      const state = raw.state && typeof raw.state === 'object' ? (raw.state as Record<string, unknown>) : {};
      return {
        reply,
        research: clean(raw.research, '', 400) || null,
        state: {
          currentLesson: clean(state.currentLesson, '', 8) || undefined,
          progress: typeof state.progress === 'number' ? state.progress : undefined,
          mastered: strings(state.mastered, 4, 160),
          struggles: strings(state.struggles, 4, 160),
          resolved: strings(state.resolved, 4, 160),
          summary: clean(state.summary, '', 700) || undefined
        }
      };
    }
  }
  // A plain-text answer is still a usable tutor turn; it just changes no state.
  const reply = clean(answer.replace(/^```(?:json)?|```$/g, ''), '', 1200);
  if (!reply) throw new Error('The tutor answered without a usable reply.');
  return { reply, research: null, state: {} };
}
