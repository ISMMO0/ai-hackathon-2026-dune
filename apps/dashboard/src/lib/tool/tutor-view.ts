import { TUTOR_JOURNAL_MARKER } from './tutors';

/** What the studio shows of one tutor, read from its Project and lesson Items. */
export interface TutorLessonView {
  id: string;
  number: number;
  title: string;
  objective: string;
  activity: string;
}

export interface TutorView {
  name: string;
  details: string[];
  approach: string;
  lessons: TutorLessonView[];
  sources: string[];
}

/** "1. Lesson 1: What can happen?" → "What can happen?" */
export function lessonTitle(name: string): string {
  return name.replace(/^\d+\.\s*/, '').replace(/^Lesson\s+\d+:\s*/i, '');
}

/** The Project description Tutor Studio writes: marker, profile, style, approach. */
export function readTutorDescription(description: string | null | undefined) {
  const lines = (description ?? '').split('\n').map((line) => line.trim());
  const details = [lines[1], lines[2]]
    .filter(Boolean)
    .flatMap((line) => line.split('·').map((part) => part.trim()))
    .filter(Boolean);
  return { details, approach: lines.slice(3).join(' ').trim() };
}

/** A lesson note: "Objective\n…\n\nActivity\n…\n\nResearch sources:\n- …". */
export function readLessonNote(note: string) {
  const section = (label: string) =>
    note.match(new RegExp(`${label}\\n([\\s\\S]*?)(?:\\n\\n|$)`))?.[1]?.trim() ?? '';
  const sources = (note.split('Research sources:\n')[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean);
  return { objective: section('Objective'), activity: section('Activity'), sources };
}

export function buildTutorView(
  project: { name: string; description?: string | null },
  items: { id: string; name: string; note: string }[]
): TutorView {
  const { details, approach } = readTutorDescription(project.description);
  const lessonItems = items
    .filter((item) => !item.note.startsWith(TUTOR_JOURNAL_MARKER))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const sources = new Set<string>();
  const lessons = lessonItems.map((item, index) => {
    const note = readLessonNote(item.note);
    note.sources.forEach((source) => sources.add(source));
    return {
      id: item.id,
      number: index + 1,
      title: lessonTitle(item.name),
      objective: note.objective,
      activity: note.activity
    };
  });
  return { name: project.name, details, approach, lessons, sources: [...sources] };
}

/** The first URL in a source line, if it has one. */
export function sourceUrl(source: string): string | null {
  return source.match(/https?:\/\/\S+/)?.[0] ?? null;
}

/** A portable SKILL.md: what any agent needs to become this tutor. */
export function buildSkillMarkdown(view: TutorView): string {
  const slug =
    view.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'tutor';
  const lessons = view.lessons
    .map(
      (lesson) =>
        `### Lesson ${lesson.number}: ${lesson.title}\n\n- Objective: ${lesson.objective}\n- Activity: ${lesson.activity}`
    )
    .join('\n\n');
  const sources = view.sources.length
    ? view.sources.map((source) => `- ${source}`).join('\n')
    : '- None recorded';
  return `---
name: ${slug}
description: Personal tutor "${view.name}". Use it to teach this learner with the lessons below.
---

# ${view.name}

## Learner
${view.details.map((detail) => `- ${detail}`).join('\n')}

## How to teach
${view.approach || 'Explain simply, use examples, check understanding often.'}

- Keep answers short: two to five sentences, then one question or exercise.
- Correct mistakes kindly and explain why.
- Stay age-appropriate and within the course.
- Never ask for personal data. Refer sensitive questions to a parent or teacher.
- Say clearly that you are an AI tutor.

## Lessons

${lessons}

## Sources
${sources}
`;
}
