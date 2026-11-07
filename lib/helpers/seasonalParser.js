/**
 * Anime sequel-title parser.
 *
 * ESM module (package.json uses "type": "module"). No external dependencies.
 */

const freeze = (value) => Object.freeze(value);

export const PARSER_CONSTANTS = freeze({
  // Roman numerals accepted by this parser: II through XXX (2–30).
  romanNumerals: freeze({
    II: 2,
    III: 3,
    IV: 4,
    V: 5,
    VI: 6,
    VII: 7,
    VIII: 8,
    IX: 9,
    X: 10,
    XI: 11,
    XII: 12,
    XIII: 13,
    XIV: 14,
    XV: 15,
    XVI: 16,
    XVII: 17,
    XVIII: 18,
    XIX: 19,
    XX: 20,
    XXI: 21,
    XXII: 22,
    XXIII: 23,
    XXIV: 24,
    XXV: 25,
    XXVI: 26,
    XXVII: 27,
    XXVIII: 28,
    XXIX: 29,
    XXX: 30,
  }),

  // English ordinal words accepted by this parser: Second through Thirtieth.
  // Hyphenated forms (Twenty-first, etc.) also accept a space instead of the hyphen.
  englishOrdinals: freeze({
    Second: 2,
    Third: 3,
    Fourth: 4,
    Fifth: 5,
    Sixth: 6,
    Seventh: 7,
    Eighth: 8,
    Ninth: 9,
    Tenth: 10,
    Eleventh: 11,
    Twelfth: 12,
    Thirteenth: 13,
    Fourteenth: 14,
    Fifteenth: 15,
    Sixteenth: 16,
    Seventeenth: 17,
    Eighteenth: 18,
    Nineteenth: 19,
    Twentieth: 20,
    'Twenty-first': 21,
    'Twenty-second': 22,
    'Twenty-third': 23,
    'Twenty-fourth': 24,
    'Twenty-fifth': 25,
    'Twenty-sixth': 26,
    'Twenty-seventh': 27,
    'Twenty-eighth': 28,
    'Twenty-ninth': 29,
    Thirtieth: 30,
  }),

  // Recognized video extensions. The extension is removed before title-end checks.
  mediaExtensions: freeze([
    '.mp4',
    '.mkv',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.m4v',
    '.mpg',
    '.mpeg',
    '.m2ts',
    '.ts',
    '.ogv',
    '.3gp',
  ]),

  // Sequence markers accepted before a number/ordinal.
  sequenceMarkers: freeze(['Season', 'Part', 'Arc', 'Cour']),

  finalIndicators: freeze(['The Final', 'Final Season']),
});

const ROMAN_PATTERN = Object.keys(PARSER_CONSTANTS.romanNumerals)
  .sort((a, b) => b.length - a.length)
  .join('|');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeOrdinalWordPattern() {
  return Object.keys(PARSER_CONSTANTS.englishOrdinals)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.split('-').map(escapeRegExp).join('[-\\s]+'))
    .join('|');
}

const ORDINAL_WORD_PATTERN = makeOrdinalWordPattern();
const MARKER_PATTERN = PARSER_CONSTANTS.sequenceMarkers.join('|');
const VALUE_PATTERN = `(?:\\d+(?:st|nd|rd|th)?|${ROMAN_PATTERN}|${ORDINAL_WORD_PATTERN})`;
const REVERSE_VALUE_PATTERN = `(?:\\d+(?:st|nd|rd|th)|${ORDINAL_WORD_PATTERN})`;

function getInputParts(input) {
  if (typeof input !== 'string') {
    throw new TypeError(`parseAnimeTitle expected a string, received ${typeof input}`);
  }

  const original = input;
  const trimmed = input.trim();
  const basename = trimmed.replace(/\\/g, '/').split('/').pop() || '';
  const extension = [...PARSER_CONSTANTS.mediaExtensions]
    .sort((a, b) => b.length - a.length)
    .find((item) => basename.toLowerCase().endsWith(item)) || null;
  const title = (extension
    ? basename.slice(0, -extension.length)
    : basename
  ).trim();

  return { original, filename: basename, title, extension };
}

function isValidOrdinalSuffix(number, suffix) {
  const mod100 = number % 100;
  if (mod100 >= 11 && mod100 <= 13) return suffix === 'th';

  const mod10 = number % 10;
  const expected = mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th';
  return suffix === expected;
}

function parseSequenceValue(rawValue) {
  if (!rawValue) return null;

  const value = rawValue.trim();
  const numeric = value.match(/^(\d+)(st|nd|rd|th)?$/i);
  if (numeric) {
    const number = Number(numeric[1]);
    if (!Number.isSafeInteger(number) || number < 2) return null;

    const suffix = numeric[2]?.toLowerCase();
    if (suffix && !isValidOrdinalSuffix(number, suffix)) return null;

    return {
      number,
      notation: suffix ? 'ordinal-number' : 'arabic',
    };
  }

  const roman = PARSER_CONSTANTS.romanNumerals[value.toUpperCase()];
  if (roman) return { number: roman, notation: 'roman' };

  const ordinalKey = value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  const ordinalEntry = Object.entries(PARSER_CONSTANTS.englishOrdinals)
    .find(([word]) => word.toLowerCase() === ordinalKey);

  if (ordinalEntry) return { number: ordinalEntry[1], notation: 'ordinal-word' };
  return null;
}

function makeMatch({
  rule,
  type,
  raw,
  value = null,
  marker = null,
  number = null,
  notation = null,
  confidence,
}) {
  return {
    rule,
    type,
    marker,
    raw,
    value,
    number,
    notation,
    confidence,
  };
}

function collectMatches(title) {
  const matches = [];
  if (!title) return matches;

  // Absolute sequel indicators. "The Final" and "Final Season" are the only
  // accepted final-related phrases; a bare "Final" is intentionally ignored.
  const theFinal = /\bThe\s+Final\b/i.exec(title);
  if (theFinal) {
    matches.push(makeMatch({
      rule: 'final_the_final',
      type: 'final',
      raw: theFinal[0],
      value: theFinal[0],
      confidence: 1,
    }));
  }

  const finalSeason = /\bFinal\s+Season\b/i.exec(title);
  if (finalSeason && !theFinal) {
    matches.push(makeMatch({
      rule: 'final_season',
      type: 'final',
      raw: finalSeason[0],
      value: finalSeason[0],
      confidence: 1,
    }));
  }

  // Explicit marker followed by a number, Roman numeral, or English ordinal.
  const markerPrefixRegex = new RegExp(
    `\\b(?<marker>${MARKER_PATTERN})\\s+(?<value>${VALUE_PATTERN})\\b`,
    'gi',
  );
  for (const markerPrefix of title.matchAll(markerPrefixRegex)) {
    const parsed = parseSequenceValue(markerPrefix.groups.value);
    if (!parsed) continue;
    const marker = markerPrefix.groups.marker;
    const type = marker.toLowerCase();
    matches.push(makeMatch({
      rule: `${type}_prefix`,
      type,
      marker,
      raw: markerPrefix[0],
      value: markerPrefix.groups.value,
      number: parsed.number,
      notation: parsed.notation,
      confidence: 1,
    }));
  }

  // S2/S3/... is accepted; "S 2" is deliberately not.
  const compactSeason = /\bS(?<value>\d+)\b/i.exec(title);
  if (compactSeason) {
    const parsed = parseSequenceValue(compactSeason.groups.value);
    if (parsed) {
      matches.push(makeMatch({
        rule: 'compact_s_number',
        type: 'season',
        marker: 'S',
        raw: compactSeason[0],
        value: compactSeason.groups.value,
        number: parsed.number,
        notation: 'arabic',
        confidence: 0.98,
      }));
    }
  }

  // Reverse form: 2nd Season, Third Season, Twenty-first Part, etc.
  // Roman numeral reverse form (e.g. "II Season") is intentionally excluded.
  const markerReverseRegex = new RegExp(
    `\\b(?<value>${REVERSE_VALUE_PATTERN})\\s+(?<marker>${MARKER_PATTERN})\\b`,
    'gi',
  );
  for (const markerReverse of title.matchAll(markerReverseRegex)) {
    const parsed = parseSequenceValue(markerReverse.groups.value);
    if (!parsed) continue;
    const marker = markerReverse.groups.marker;
    const type = marker.toLowerCase();
    matches.push(makeMatch({
      rule: `${type}_ordinal_prefix`,
      type,
      marker,
      raw: markerReverse[0],
      value: markerReverse.groups.value,
      number: parsed.number,
      notation: parsed.notation,
      confidence: 0.99,
    }));
  }

  // Standalone Roman numerals and Arabic numerals must be the final title token
  // or immediately precede a colon. They are evaluated after extension removal.
  const standaloneBoundary = '(?:^|[\\s._–—:-])';
  const titleEndOrColon = '(?=\\s*(?::|$))';

  const standaloneRomanRegex = new RegExp(
    `${standaloneBoundary}(?<value>${ROMAN_PATTERN})${titleEndOrColon}`,
    'i',
  );
  const standaloneRoman = standaloneRomanRegex.exec(title);
  if (standaloneRoman) {
    const tokenIndex = standaloneRoman.index + standaloneRoman[0].lastIndexOf(standaloneRoman.groups.value);
    const beforeToken = title.slice(0, tokenIndex);
    const isMarkerValue = /\b(?:Season|Part|Arc|Cour)\s+$/i.test(beforeToken);
    if (!isMarkerValue) {
      const parsed = parseSequenceValue(standaloneRoman.groups.value);
      if (parsed) {
        matches.push(makeMatch({
          rule: 'standalone_roman',
          type: 'standalone',
          marker: null,
          raw: standaloneRoman[0].trim(),
          value: standaloneRoman.groups.value,
          number: parsed.number,
          notation: 'roman',
          confidence: 0.85,
        }));
      }
    }
  }

  const standaloneArabicRegex = new RegExp(
    `${standaloneBoundary}(?<value>\\d+)${titleEndOrColon}`,
    'i',
  );
  const standaloneArabic = standaloneArabicRegex.exec(title);
  if (standaloneArabic) {
    const tokenIndex = standaloneArabic.index + standaloneArabic[0].lastIndexOf(standaloneArabic.groups.value);
    const beforeToken = title.slice(0, tokenIndex);
    const isMarkerValue = /\b(?:Season|Part|Arc|Cour)\s+$/i.test(beforeToken);
    const isRejectedSpacedS = /\bS\s+$/i.test(beforeToken);
    if (!isMarkerValue && !isRejectedSpacedS) {
      const parsed = parseSequenceValue(standaloneArabic.groups.value);
      if (parsed) {
        matches.push(makeMatch({
          rule: 'standalone_arabic',
          type: 'standalone',
          marker: null,
          raw: standaloneArabic[0].trim(),
          value: standaloneArabic.groups.value,
          number: parsed.number,
          notation: 'arabic',
          confidence: 0.8,
        }));
      }
    }
  }

  // English ordinal words as a standalone suffix, optionally preceded by "The".
  // They follow the same title-end / before-colon boundary rule as bare suffixes.
  const standaloneOrdinalRegex = new RegExp(
    `${standaloneBoundary}(?:The\\s+)?(?<value>${ORDINAL_WORD_PATTERN})${titleEndOrColon}`,
    'i',
  );
  const standaloneOrdinal = standaloneOrdinalRegex.exec(title);
  if (standaloneOrdinal) {
    const tokenIndex = standaloneOrdinal.index + standaloneOrdinal[0].lastIndexOf(standaloneOrdinal.groups.value);
    const beforeToken = title.slice(0, tokenIndex);
    const isMarkerValue = /\b(?:Season|Part|Arc|Cour)\s+$/i.test(beforeToken);
    if (!isMarkerValue) {
      const parsed = parseSequenceValue(standaloneOrdinal.groups.value);
      if (parsed) {
        matches.push(makeMatch({
          rule: 'standalone_ordinal_word',
          type: 'standalone',
          marker: null,
          raw: standaloneOrdinal[0].trim(),
          value: standaloneOrdinal.groups.value,
          number: parsed.number,
          notation: 'ordinal-word',
          confidence: 0.88,
        }));
      }
    }
  }

  return matches;
}

/**
 * Parse sequel indicators from an anime title or a media filename.
 *
 * A false `isSequel` means only that no accepted sequel pattern was found;
 * it does not prove that the work is chronologically the first in its franchise.
 *
 * @param {string} input Anime title, filename, or path ending in a recognized video extension.
 * @returns {object} Structured sequel-detection result.
 */
export function parseAnimeTitle(input) {
  const parts = getInputParts(input);
  const matches = collectMatches(parts.title);

  // Prefer explicit final phrase, then explicit Season, then S-number, followed
  // by Part/Arc/Cour, reverse ordinal forms, and standalone suffixes.
  const priority = (match) => {
    if (match.type === 'final') return 0;
    if (match.type === 'season' && match.rule !== 'compact_s_number') return 1;
    if (match.rule === 'compact_s_number') return 2;
    if (['part', 'arc', 'cour'].includes(match.type)) return 3;
    if (match.rule === 'standalone_roman') return 4;
    if (match.rule === 'standalone_arabic') return 5;
    if (match.rule === 'standalone_ordinal_word') return 6;
    return 7;
  };

  matches.sort((a, b) => priority(a) - priority(b));
  const indicator = matches[0] || null;
  const sequelMatch = matches.length > 0;
  const seasonMatch = matches.find((match) => match.type === 'season')
    || (indicator?.type === 'standalone' ? indicator : null);

  return {
    input: parts.original,
    filename: parts.filename,
    title: parts.title,
    extension: parts.extension,
    isSequel: sequelMatch,
    status: sequelMatch ? 'sequel-pattern-found' : 'no-sequel-pattern-found',
    seasonNumber: seasonMatch?.number ?? null,
    indicator,
    matches,
  };
}

export default parseAnimeTitle;
