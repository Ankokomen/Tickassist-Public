# Contributing to TickAssist

Fixes and improvements are welcome. Two things are worth knowing first.

## How a change gets in

This repository is **published**, not developed in: at every release its
contents are replaced with the program as that version installs it. A pull
request here is therefore never merged here. Instead:

1. Open a pull request against `main`, as usual. Keep it to one change, and
   say what it fixes and how you checked it.
2. A maintainer imports it into the source the program is built from, where
   it is reviewed and tested. Your name stays on the commit.
3. If it is accepted, it arrives in this repository with the next release,
   and the pull request is closed with a note saying which one.

A few files here are generated at each release and cannot be changed by a
pull request: `app/owner.json`, `VERSION`, `.gitattributes`, `latest.json`
and `versions.json`. `USER-GUIDE.md` can be: it is the guide.

Bugs and ideas without a patch are just as welcome as
[issues](https://github.com/Ankokomen/Tickassist-Public/issues).

## The license

TickAssist is source-available, not open source: see [LICENSE.md](LICENSE.md).
Forking this repository to prepare a pull request is allowed; publishing
that copy, or using it commercially, is not. By sending a contribution you
agree to section 4 of the license, which lets the maintainers use it as part
of TickAssist under any terms.
