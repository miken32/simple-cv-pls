# simple-cv-pls
I am not much of a power user, so the *many* extra features on the [standard request generator](https://github.com/SO-Close-Vote-Reviewers/UserScripts) were not enough to make up for some clunky UI.  Also I haven't done a lot with JavaScript – beyond some basic DOM stuff – in a dozen years, and wanted to take ES6 for a spin. (Did this userscript *need* a class? No. Does it have two of them? Yes.) Hence this minimal request generator for sending <kbd>cv-pls</kbd> requests to SOCVR, which I enjoyed making and will continue using even if nobody else does.

## Features
* Simple user interface built from Stacks components
* Automatically select destination room for old questions
* Allow sending requests from the native SO close dialog
* Details of your votes and requests are saved for when you later revisit a post
* Inobtrusive timed reminders to revisit pages

## Non-features
* Requesting from review queues
* Sending anything other than <kbd>cv-pls</kbd>, <kbd>del-pls</kbd>, <kbd>reopen-pls</kbd>, or <kbd>flag-pls</kbd> requests
* Sending to rooms other than SOCVR and SOCVR old questions
* Working on any sites other than SO

## Things I'd like to fix
* Post requests to the old questions room despite recent activity, if that activity was from me
* Maybe do a Roomba check and add a note to <kbd>del-pls</kbd> requests like the standard script does
* Don't allow posting repeated requests too soon, per room rules
