# Design ideas: making the admin app obvious

These are ideas borrowed from software that explains complicated things simply: GOV.UK, ScratchJr, Duolingo, Monzo, Apple Shortcuts, Microsoft Inclusive Design and LEGO instructions. A version with phone sketches is published as a private page on claude.ai (link in the pull request). Nothing here is built yet.

## Five rules behind every idea
- **One thing at a time.** Each screen asks one question or shows one job (GOV.UK).
- **Pictures before words.** Steps can be recognised without reading (ScratchJr, LEGO).
- **Show, then tell.** People try it before it's explained (Duolingo).
- **Say why, in a sentence.** Every automatic action explains itself (Monzo).
- **Design for one hand.** Owners use the app on a ladder or between clients (Microsoft inclusive design).

## If we only build three
1. The flow in one sentence (idea 1)
2. Replies waiting, one at a time (idea 2)
3. The trust ladder (idea 4)

## The ideas

| # | Idea | Inspired by | Where | Effort |
|---|---|---|---|---|
| 1 | **Your flow, read as a sentence.** Each block's icon shows the choice made: a calendar, a link or a person. A tappable sentence under the blocks reads, for example: "When a message arrives, I'll offer 3 free times from your calendar, write back warmly, ask you before sending, then ask how it went the day after the job." | ScratchJr, IFTTT | Flows | Small |
| 2 | **Replies waiting, one at a time.** One big reply with Approve / Edit / Reject and a "1 of 3" counter, with what the customer said shown above it. ⚠️ replies come first and are labelled in words. | GOV.UK "one thing per page", Duolingo | Overview / Inbox | Medium |
| 3 | **"Try it".** Plays a pretend enquiry through the flow, lighting up each step, and ends with the exact reply the customer would get. Nothing is sent and the calendar isn't touched. The reply style panel shows a live preview. | Duolingo (lesson before sign-up), children's "Read to me" mode | Flows | Medium |
| 4 | **The trust ladder.** Each kind of reply shows where it is: Asking you → Ready to offer → Automatic, with a bar such as "4 of 5 approved without changes". Kinds that are never automated show a lock and the reason. | Apple Shortcuts "Ask Before Running", training wheels, Duolingo progress | Flows → You approve | Small (data already in the API) |
| 5 | **Every automatic action says why.** Activity becomes a feed of sentences, for example: "Sent to Sam automatically. You said yes to automating Offering times on 20 Nov." Each automatic send has a one-tap *Switch back to asking*. | Monzo writing principles, bank feeds | Activity | Medium |
| 6 | **Setup as a task list, with what you'll need.** Each task is marked Done, To do or Can't start yet. A "what you'll need" strip lists your Google login, work phone, booking link and price list. | GOV.UK "Complete multiple tasks", LEGO | Overview → Setup | Small |
| 7 | **Built for one hand, outdoors, in a hurry.** Main actions sit at the bottom of the screen, at least 48px tall. Contrast and text size go up (Atkinson Hyperlegible font). Status is shown in words as well as colour. Keyboard and screen-reader checks are automated. | Microsoft persona spectrum | Whole app | Medium |
| 8 | **Say it the way the owner would.** Triage → *Read and sort*. Draft → *Reply waiting for you*. Hold → *Time pencilled in*. Use case → *Job*. Reviewer score → *Looks good / Have a closer look*. | GOV.UK content design, Monzo | Labels | Small |
| 9 | **A quiet weekly "here's what I did".** For example: "12 enquiries answered, 6 minutes on average, 4 booked, 2 quotes chased." There are no streaks and no guilt. It can also arrive as a Friday WhatsApp message if the owner wants it. | Duolingo weekly report, sticker charts | Overview + WhatsApp | Small–Medium |

## Sources
- GOV.UK: [One thing per page](https://designnotes.blog.gov.uk/2015/07/03/one-thing-per-page/), [Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks)
- [ScratchJr](https://en.wikipedia.org/wiki/ScratchJr) and its [design paper](https://sites.bc.edu/devtech/wp-content/uploads/sites/181/2018/02/scratchjr_idc_2013.pdf)
- [Apple Shortcuts: personal automations](https://support.apple.com/en-au/guide/shortcuts/apd602971e63/ios)
- [Nielsen Norman Group: Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- [Duolingo onboarding (Appcues)](https://goodux.appcues.com/blog/duolingo-user-onboarding)
- [Monzo writing principles](https://monzo.com/tone-of-voice/)
- [Microsoft Inclusive Design](https://inclusive.microsoft.design/)
- [LEGO: How we design our building instructions](https://www.lego.com/en-si/service/help-topics/article/how-we-design-our-building-instructions)
