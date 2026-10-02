import { describe, expect, it } from 'vitest';
import { buildSkillMarkdown, buildTutorView, lessonTitle, readLessonNote, sourceUrl } from './tutor-view';
import { TUTOR_JOURNAL_MARKER } from './tutors';

const project = {
  name: "Sam's French Tutor",
  description:
    'Created by Tutor Studio\n10 years old · Complete beginner · English\nShort games · Warm and encouraging\nLearn through games.'
};

const items = [
  {
    id: 'b',
    name: '2. Lesson 2: Colours',
    note: 'Objective\nName colours.\n\nActivity\nColour hunt.\n\nResearch sources:\n- Site A https://a.example/x'
  },
  {
    id: 'a',
    name: '1. Lesson 1: Hello',
    note: 'Objective\nSay hello.\n\nActivity\nRole play.\n\nResearch sources:\n- Site A https://a.example/x'
  },
  { id: 'j', name: 'Learning journal', note: `${TUTOR_JOURNAL_MARKER}\nProgress: 20%` }
];

describe('the studio’s tutor view', () => {
  it('reads the profile, the lessons in order and the sources once, without the journal', () => {
    const view = buildTutorView(project, items);
    expect(view.details).toEqual([
      '10 years old',
      'Complete beginner',
      'English',
      'Short games',
      'Warm and encouraging'
    ]);
    expect(view.approach).toBe('Learn through games.');
    expect(view.lessons.map((l) => [l.number, l.title, l.objective, l.activity])).toEqual([
      [1, 'Hello', 'Say hello.', 'Role play.'],
      [2, 'Colours', 'Name colours.', 'Colour hunt.']
    ]);
    expect(view.sources).toEqual(['Site A https://a.example/x']);
  });

  it('reads a lesson note without sources, a title and a source URL', () => {
    expect(readLessonNote('Objective\nO.\n\nActivity\nA.')).toEqual({
      objective: 'O.',
      activity: 'A.',
      sources: []
    });
    expect(lessonTitle('3. Practice 3')).toBe('Practice 3');
    expect(sourceUrl('Site https://x.example/a')).toBe('https://x.example/a');
    expect(sourceUrl('No link')).toBeNull();
  });

  it('builds a SKILL.md with front matter, lessons, rules and sources', () => {
    const skill = buildSkillMarkdown(buildTutorView(project, items));
    expect(skill.startsWith('---\nname: sam-s-french-tutor\n')).toBe(true);
    expect(skill).toContain('### Lesson 2: Colours');
    expect(skill).toContain('Never ask for personal data');
    expect(skill).toContain('- Site A https://a.example/x');
  });
});
