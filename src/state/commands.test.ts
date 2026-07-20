import { describe, expect, it } from 'vitest'
import type { SkillInfo } from '../api/events'
import { COMMANDS, filterCommands, parseSlash, slashNameFilter } from './commands'

const skills: SkillInfo[] = [
  { name: 'write-goal', description: 'Craft a goal', path: '/a', source: 'builtin' },
  { name: 'harness-dev', description: 'Dev loop', path: '/b', source: 'project' },
  { name: 'live-probe', description: 'Probe the daemon', path: '/c', source: 'user' },
]

describe('parseSlash', () => {
  it('returns null for plain text', () => {
    expect(parseSlash('hello')).toBeNull()
    expect(parseSlash('')).toBeNull()
    expect(parseSlash('a /yolo')).toBeNull()
  })

  it('parses a bare command', () => {
    expect(parseSlash('/yolo')).toEqual({ name: 'yolo', args: '' })
  })

  it('parses command + args, preserving spacing in args', () => {
    expect(parseSlash('/goal fix the docs  build')).toEqual({ name: 'goal', args: 'fix the docs  build' })
    expect(parseSlash('/title   My session')).toEqual({ name: 'title', args: 'My session' })
  })

  it('normalizes case in the command name only', () => {
    expect(parseSlash('/YOLO')).toEqual({ name: 'yolo', args: '' })
    expect(parseSlash('/Title Foo')).toEqual({ name: 'title', args: 'Foo' })
  })

  it('returns null for a lone slash', () => {
    expect(parseSlash('/')).toBeNull()
  })
})

describe('slashNameFilter', () => {
  it('is active only while typing the name', () => {
    expect(slashNameFilter('/')).toBe('')
    expect(slashNameFilter('/yo')).toBe('yo')
    expect(slashNameFilter('/yolo on')).toBeNull()
    expect(slashNameFilter('hello')).toBeNull()
  })
})

describe('filterCommands', () => {
  it('returns everything for an empty query', () => {
    const g = filterCommands('', skills)
    expect(g.commands).toHaveLength(COMMANDS.length)
    expect(g.skills).toHaveLength(skills.length)
  })

  it('matches substrings case-insensitively in both sections', () => {
    const g = filterCommands('GO', skills)
    expect(g.commands.map((c) => c.name)).toEqual(['goal'])
    expect(g.skills.map((s) => s.name)).toEqual(['write-goal'])
  })

  it('returns empty groups when nothing matches', () => {
    const g = filterCommands('zzz', skills)
    expect(g.commands).toHaveLength(0)
    expect(g.skills).toHaveLength(0)
  })
})
