/**
 * Name and flavour pools.
 *
 * Given names are kept in a single undifferentiated pool: the generator picks
 * pronouns independently of the name, because inferring one from the other is
 * exactly the kind of assumption a profiling game should not be modelling.
 */

export const GIVEN_NAMES = [
  "Aron", "Sarah", "Tobias", "Marisol", "Devon", "Priya", "Emeka", "Yuki",
  "Camille", "Idris", "Noor", "Bastian", "Rhea", "Kwame", "Lena", "Óscar",
  "Thandiwe", "Milo", "Anaïs", "Rustam", "Freya", "Hugo", "Zainab", "Kiran",
  "Beatriz", "Otto", "Sunny", "Ivo", "Maren", "Tam", "Delphine", "Rafe",
  "Ines", "Quincy", "Halle", "Nikolai", "Suki", "Amare", "Wren", "Casimir",
  "Leandro", "Bo", "Fatima", "Gus", "Ilse", "Jonah", "Keziah", "Lior",
  "Mika", "Nell", "Osei", "Petra", "Rio", "Saoirse", "Tariq", "Uma",
  "Viggo", "Wanjiru", "Xiomara", "Yannis", "Zeph", "Adaeze", "Bram", "Coralie",
];

export const FAMILY_NAMES = [
  "Vance", "Okonkwo", "Reyes", "Lindqvist", "Bhatt", "Moreau", "Castellanos",
  "Nakashima", "Doyle", "Abara", "Petrossian", "Kowalczyk", "Fenwick", "Duarte",
  "Sørensen", "Mbeki", "Halloran", "Ferreira", "Quintero", "Aoyama", "Baptiste",
  "Novak", "Ellery", "Iwu", "Zhao", "Marchetti", "Krishnan", "Bergström",
  "Tanaka", "Osgood", "Villanueva", "Achebe", "Rasmussen", "Delacroix",
  "Sandoval", "Kimura", "Wren", "Ferris", "Oyelaran", "Blackwood", "Ramesh",
  "Solano", "Thibault", "Ngata", "Ivanov", "Farrow", "Beaumont", "Adeyemi",
];

export const PRONOUN_SETS = ["they/them", "she/her", "he/him"] as const;

/** Generic quirks — the "one weird line" that makes a passive scan worth doing. */
export const GENERIC_QUIRKS = [
  "Has left 41 one-star reviews for the same laundromat",
  "Owns eleven identical black turtlenecks",
  "Fluent in Klingon, conversational in Finnish",
  "Has never once eaten a vegetable in a photograph",
  "Runs an anonymous account reviewing municipal benches",
  "Believes the moon landing happened twice",
  "Trains competitively for speed-cubing, ranked 14th regionally",
  "Keeps a spreadsheet rating every stairwell in the district",
  "Was briefly a contestant on a cancelled cooking show",
  "Has an unresolved dispute with a parking authority in another city",
  "Sends themselves voice memos at 4am and never listens back",
  "Collects hotel keycards; has 300 and counting",
  "Has been banned from three separate trivia leagues",
  "Nurses a decade-long grudge against a former roommate's cat",
  "Once queued nine hours for a sandwich and calls it a personality trait",
  "Refuses to use the letter 'z' in passwords for superstitious reasons",
  "Has a second phone exclusively for a mobile farming game",
  "Wrote 400 pages of fan fiction about a shipping logistics drama",
  "Insists on paying for everything in exact change",
  "Has an alarm labelled 'do not answer him' set for every Thursday",
  "Ranks colleagues by the quality of their desk chairs",
  "Sleeps with a police scanner running",
  "Is quietly the top-ranked player of a 1997 racing game",
  "Has never successfully parallel parked and lies about it",
];

/** Interests double as the vocabulary for fabricated app alerts. */
export const INTEREST_POOL = [
  "vintage synthesizers",
  "amateur astronomy",
  "competitive baking",
  "sneaker resale",
  "trail running",
  "aquarium keeping",
  "true crime podcasts",
  "fantasy football",
  "mechanical keyboards",
  "birdwatching",
  "crypto trading",
  "sourdough",
  "model railways",
  "salsa dancing",
  "rare houseplants",
  "drone racing",
  "estate auctions",
  "retro computing",
  "wine collecting",
  "motorcycle restoration",
  "chess",
  "sea kayaking",
  "film photography",
  "urban foraging",
];

/** Services that show up in phone dumps and credential reuse. */
export const SERVICES = [
  "Chatterbox",
  "Nudl",
  "Voltmail",
  "Kismet",
  "Orbit Bank",
  "SpinLoop",
  "MealDash",
  "Bidsy",
  "Pulsegram",
  "Warden Health",
  "ShiftKey",
  "Loft",
];
