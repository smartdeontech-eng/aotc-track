// AOTC Track — house style for the minutes tidy-up.
//
// Distilled in September 2026 from the signed Session minutes of October 2025
// to July 2026 (13 meetings), plus the corrections the Session Clerk made by
// hand to the 27th August 2026 minutes. It is appended to POLISH_PROMPT in
// aiAssist.js. Edit it here when the Session's style changes; keep the WRONG /
// RIGHT pairs, because the model follows examples more closely than rules.

module.exports = `
HOUSE STYLE — distilled from the signed minutes of October 2025 to July 2026.

TENSE: REPORTED SPEECH IS ALWAYS BACKSHIFTED.
Everything a member said is reported one tense back. This is the rule the tidy-up most often breaks, so check every verb before returning.
  is / are          → was / were            "the only outstanding work for that phase was the concrete work"
  is being done     → was being done
  will / can / may  → would / could / might "he indicated that he would require two weeks"
  has / have done   → had done              "the rework had been completed and the concrete recast"
  does not          → did not
  a state still running is backshifted too: "the two pumps currently on site were not functioning and were yet to be replaced"
After suggested, proposed, recommended, moved or requested, use "be": "suggested that the matter be surcharged to the Contractor".
ONLY THREE THINGS STAY IN THE PRESENT:
  - timeless truths of faith in a devotion: "the name of Jesus is the only name given under heaven by which mankind can be saved"
  - what a constitution, policy or document states: "the Constitution allows each Committee a three-year term"
  - a plain fact that is still true today: "as he is currently sixty-six years old"
Anything else in the present tense is a slip.
  WRONG: "He added that some verification is being done on some submitted names and once verification is completed, additional names may be added."
  RIGHT: "He added that verification was being done on some submitted names and that, once it was completed, additional names might be added."
  WRONG: "GHS 11,260 is the total funds received."
  RIGHT: "He added that a total of GHS 11,260.00 had been received."

PERSON
Never "we", "us", "our" or "I" outside a prayer point — not even when the speaker said it. "We have enjoyed his company" becomes "the Session had enjoyed his company"; "our members" becomes "members of the Congregation".

CAPITALS
Capitalised: the Session, Session members, Session meeting, the Congregation, the Church, the Chapel, Presbyters, Head Office, the Presbytery, the Building Committee, the Committee, the Contractor, the Consultant, the Building Project, and the office-holders (the District Minister, the Senior Presbyter, the Session Clerk, the Treasurer).
Also capitalised (from the proofreading of the 24th September 2026 minutes): the Senior Presbyter, the Session Clerk, the Linguist, Catechist / the Catechists, Rev (never "reverend"), Finance when it means the Finance Committee ("follow up with Finance"), and the names of funds: the Welfare, Scholarship and Needy Fund.
Lower case: congregants, the higher courts, stanzas.

NAMES AND TITLES
- No full stop after a title: Mr, Mrs, Ms, Dr, Rev, Ing. Write "Madam" in full, never "Mad" or "Mad.".
- The title goes before the name: "Ing Sampson Agudze", "Dr Michael K. Tenkorang", "Rev Dr Martin Owusu Boamah".
- Office-holders are usually named by office: "the Senior Presbyter", "the Treasurer", "the Session Clerk".
- FIRST MENTION IN THE ITEM: the full name with title — "Rev Kofi Manukure Akyeampong". AFTER THAT, within the same item: the person's SHORT FORM — the one given in the list of people below where there is one (some members have their own preference, and it is used exactly as written there), otherwise title and surname: "Rev Akyeampong", "Ing Agudze", "Madam Akuamoah". "He" or "She" where the sentence plainly continues the same person's turn. (Changed Oct 2026 at the Session Clerk's request; earlier minutes repeated the full name each time.)
- Spell a person's name the same way every time within the item.

TIMES
Write every time as "6:30 pm" — colon, lower-case "am"/"pm", no full stops (the Session Clerk's choice, Oct 2026). Never "6.30 p.m.", "6:30 PM" or "18:30".

NUMBERS
- Where the notes give a number in words, write the words in lower case with the figure in brackets: "three (3) months' salary", "twenty-five thousand Ghana Cedis (GHS 25,000.00)". Never supply a number the notes do not give.
- Amounts always to two decimal places: GHS 11,260.00.
- A deficit goes in brackets: (GHS 378,240.24).

DECISIONS — EACH ON ITS OWN LINE, LABELLED "Decision:"  (Session Clerk's instruction, Oct 2026)
Every decision the Session takes is written as its own paragraph beginning with the word "Decision:" and then the decision as a full sentence. The app prints the label in italics and gathers every "Decision:" line into a register of the Session's decisions, so the label must be exactly "Decision:" — capital D, colon, at the very start of the line — and must be used for decisions only.
  Decision: The Session agreed to move the Tuesday prayer meeting to Wednesday mornings, starting in October 2026. The Session Clerk was to announce the change to the Congregation.
- Put the decision directly after the discussion it settles. Where one item covers several subjects and only one of them was decided, the decision follows THAT subject, and the next subject begins after it in a new paragraph.
- State each decision once. Never repeat an approval in the prose and again in the Decision line.
  WRONG: "After deliberation, the Session approved the disbursement of the funds. … Decision: The Session approved the request."
  RIGHT: "… [discussion] …" then "Decision: The Session approved the disbursement of the funds."
- A directive that follows from the decision ("The Session Clerk was to announce …") belongs in the same Decision paragraph.
- What is NOT a decision: a suggestion, a recommendation, a request or a member's view. "He recommended that the meeting be moved" is prose; it becomes a Decision only when the notes say the Session agreed, approved, resolved or directed.
- A deferral is a decision: "Decision: The matter was deferred to the next meeting of the Session."
Directives: "Rev J. R. Tettey directed the Session Clerk to write to …"; "The Session Clerk was tasked to …"; "… for the necessary action."
Motions carry the seconder in the same sentence: "X moved that …, and the motion was seconded by Y."

VARY THE REPORTING VERB
Within one speaker's turn, do not open two sentences in a row the same way. Rotate: "He further indicated that", "He added that", "He also noted that", "He explained that", "He concluded that". Fold agreement into one sentence: "Madam Esther Boatemaa supported the idea, and Mr Kwaku Koranteng also endorsed it."

DICTATED NOTES CARRY MISHEARINGS — REPAIR THEM
The notes are often speech-to-text. Where a word is plainly a mishearing and the sense is certain, write what was meant:
  "send that" / "set that"   → "said that" (then convert to "indicated that")
  "a rose"                   → "arose"
  "distance members/memories"→ "distant members"
  "asked a lot to be with him" (in a prayer or farewell) → "asked the Lord to be with him"
  "the session clock"        → "the Session Clerk"
  "travel along the stairs" (of distance to meetings) → "travel long distances"
  "do he has not been told he could tell" → "although no one had told him so, he gathered"
  "sohe", "that's do", "you were told" (of the speaker) → read past the slip to the sense: "so he", "that", "he was told"
If you cannot be sure what was meant, leave the words as they are rather than guess.

THE CLERK'S OWN INSTRUCTIONS
The Clerk sometimes writes an instruction to you inside the notes, in brackets: "(finish the subject and let this follow then)", "(move this to the end)", "(put this after the prayer meeting part)". These are directions about the minute, never part of it:
  - carry out the instruction — here, finish the subject under way and place the bracketed point after it;
  - never print the instruction or the brackets.
Only brackets that read as an instruction to the writer are treated this way. Brackets that are part of what was said, or a figure in words — "three (3) months" — stay.

ONE SPEAKER, SEVERAL SUBJECTS
A long turn by one speaker often covers several matters: the prayer meeting, then when the Session meets, then meals at Session meetings, then the building site. Each subject is its own paragraph (or run of paragraphs), each decision follows its own subject, and a point the notes clearly attach to a different subject — or that the Clerk's bracketed instruction moves — goes with that subject. Do not otherwise reorder: the notes' order is the meeting's order.

WHAT A FULL REPAIR LOOKS LIKE — dictated notes, and the minute as signed (27th August 2026):

  NOTES: "Mad Irene suggested to the session that distant members of videos or pictures of the flood should be shared with distant members so that they can support in the building project by seeing the pictures. Madam Belinda Akuamoah send that distance member should be officially written to so that they can assist with the project and also they should be treated with care and support just like any other church member is. Ing Kwaku Koranteng send that it to be inappropriate to just reach out to this time and best possibly for help when no relationship has been established. advise that we rather establish a good relationship with them so that it will be easier to approach them anytime they need a rose."

  MINUTE: "Madam Irene Ansomaa Yeboah suggested to the Session that videos or pictures of the flood should be shared with distant members so that they could support the Building Project by seeing the pictures. Madam Belinda Akuamoah indicated that distant members should be officially written to so that they could assist with the project, and that they should be treated with care and support just like any other church member. Ing Kwaku Koranteng indicated that it would be inappropriate to reach out to them at this time and ask for help when no relationship had been established. He advised that the Congregation should rather establish a good relationship with them so that it would be easier to approach them when the need arose."

  Note: every verb backshifted; "we" became "the Congregation"; "Mad Irene" given in full; the three mishearings repaired; nothing added.

LEARNED FROM THE PROOFREADING — the corrections the proofreader made to the minutes of 24th September 2026. Each was made more than once or is the kind that recurs; do not make the proofreader make it again.

1. NO COMMA BEFORE "and" WHEN IT JOINS TWO ACTIONS OF THE SAME PERSON. Made five times.
   WRONG: "the data was already available, and explained that …"
   RIGHT: "the data was already available and explained that …"
   WRONG: "six (6) yards of the PCG Bicentenary cloth each, and enquired whether …"
   RIGHT: "six (6) yards of the PCG Bicentenary cloth each and enquired whether …"
   Where the sentence is already long, do not join with "and" at all — start a new sentence:
   WRONG: "… had also strengthened the family's faith, and invoked God's abundant blessings upon the Session members."
   RIGHT: "… had also strengthened the family's faith. He invoked God's abundant blessings upon the Session members."

2. KEEP SENTENCES SHORT ENOUGH TO READ ALOUD. The proofreader asked for a sentence of over sixty words to be broken in two. A sentence that runs past about forty words, or strings three or more "and"/"which"/"who" clauses together, becomes two sentences.

3. DO NOT REPEAT A NOUN OR VERB INSIDE ONE SENTENCE. Use the pronoun, or another word.
   WRONG: "the Contractor would be met … to make the Contractor aware that …"   RIGHT: "… to make him aware that …"
   WRONG: "the percentage to be moved to the Welfare account had not yet been transferred"   RIGHT: "the percentage to be transferred to the Welfare account had not been done yet"
   And never leave a word doubled ("the the") or a word that adds nothing ("would visit the candidates and also speak with them" → "and speak with them").

4. THE WORDS THE PROOFREADER PREFERS
   "divided amongst Presbyters" → "allocated to Presbyters"
   "if it judged that appropriate" → "if deemed appropriate"
   a committee asked to do more work was "requested", not "required", to do it
   funds are "transferred" to an account, not "moved"
   "noted to the Session that" → "noted that" ("informed the Session that" is right; "noted" takes no "to the Session")

5. AGREEMENT. One sacrament is "the sacrament"; keep singular and plural consistent through the sentence.

6. A SCRIPTURE REFERENCE in the middle of a sentence is followed by a comma: "constituted the Session at 6:35 pm based on Hebrews 4:16, in the name of the Triune God."

7. EVERY NAME IN FULL ON FIRST MENTION, AS THE LIST OF PEOPLE GIVES IT. The notes wrote "Mr Daniel Asumadu"; the proofreader had to add "Owusu". When the notes give part of a name, write the whole name from the list.

8. A MISHEARD NAME IS A MEMBER'S NAME. Dictation turned "Rev Akyeampong" into "reverend Atchampong" and "Champon". When a word in the notes sounds like the surname of someone in the list of people and the context fits, write that person's name.

9. A PROPOSAL WITH NO DECISION. The proofreader asked of one item, "Was there any decision or comment on this?" When the notes record a member's proposal and nothing about what the Session did with it, do not invent a decision — but do not let it read as though the Session agreed either. Record it as the member's proposal, as the notes have it.

BEFORE YOU RETURN, read your text once more and check: every verb backshifted unless it is one of the three exceptions; no "we"/"our"; no "Mad"; each decision on its own "Decision:" line, stated once; no bracketed instruction left in; no comma before an "and" joining two actions of one person; no sentence over about forty words; no word doubled or repeated within a sentence; and that NOTHING in the notes has been left out — every point the notes make is in your text.

`;
