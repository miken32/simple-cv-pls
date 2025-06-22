// ==UserScript==
// @name         Simple cv-pls Generator
// @namespace    miken32
// @version      1.0
// @description  A simpler cv-pls request generator for StackOverflow
// @author       Michael Newton
// @match        https://stackoverflow.com/questions/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=stackoverflow.com
// @updateURL    https://github.com/miken32/simple-cv-pls/raw/main/simple-cv-pls.user.js
// @downloadURL  https://github.com/miken32/simple-cv-pls/raw/main/simple-cv-pls.user.js
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.openInTab
// @connect      chat.stackoverflow.com
// ==/UserScript==
/* global StackExchange, Stacks, $ */
/**
 * A popup and associated trigger button are added to the question and each answer on a page.
 * As well, the Stack Overflow close dialog is modified to include a checkbox to send a request.
 *
 * Using the popup or checking the box when casting a close vote will send a request to the
 * appropriate chat room (based on the last activity date of the question.) The request can be
 * to close or reopen, delete or undelete, or flag the post.
 *
 * When the popup is submitted, or when a close vote is cast (regardless of checkbox setting)
 * details of the request are saved into a setting named with the post ID; a separate setting
 * contains an object with post ID as property and timestamp as value, used as an index. From
 * the popup, a user can also request a revisit reminder; these are saved in a single setting
 * object where the property is the post ID and value is the time.
 *
 * On each page load the post details settings are checked; any settings beyond a certain age
 * threshold are deleted. As well, the revisit list is checked. If any pending revisits are
 * found the user is prompted with a popover that can remove the revisits from the list and
 * open the posts in new tabs.
 */

"use strict";

(function() {
    /**
     * we're loading a page!
     */
    StackExchange.ready(function () {
        new cvPls().pageLoadHandler();
    });
})();

/**
 * Class to hold the functionality of the userscript
 *
 */
class cvPls {
    // we'll make these uppercase so we can pretend they're constants
    /** @var {Boolean} DEBUG set to true to log verbosely, post all messages to sandbox, and revisit in minutes instead of days */
    static DEBUG = false;

    /** @var {Boolean} ENABLE_LOG set to true to enable logs, but not other debug behaviour */
    static ENABLE_LOG = false;

    /** @var {Boolean} ERASE_ALL_LOCAL_STORAGE set this and DEBUG true to wipe out any stored data */
    static ERASE_ALL_LOCAL_STORAGE = false;

    /** @var {Number} STORE_DETAILS_FOR_DAYS items in the index older than this are deleted */
    static STORE_DETAILS_FOR_DAYS = 180;

    /** @var {String} SOCVR_ROOM chat room id */
    static SOCVR_ROOM = "41570";

    /** @var {String} SOCVR_OLD_ROOM chat room id */
    static SOCVR_OLD_ROOM = "253110";

    /** @var {String} SANDBOX_ROOM chat room id */
    static SANDBOX_ROOM = "1";

    /** @var {Number} OLD_ROOM_DAYS the age limit for posts to SOCVR */
    static OLD_ROOM_DAYS = 180;

    /** @var {String} REQUEST_BUTTON_TEXT the label for the button placed next to close/flag/follow/etc. */
    static REQUEST_BUTTON_TEXT = "*-pls";

    /** @var {Object} CLOSE_REASON_TEXT maps the values in the SO close popover to something readable */
    static CLOSE_REASON_TEXT = {
        "Duplicate": "Duplicate",
        "NeedsDetailsOrClarity": "Needs details or clarity",
        "NeedMoreFocus": "Needs more focus",
        "OpinionBased": "Opinion-based",
        "18": "Not about programming",
        "16": "Seeking recommendations",
        "13": "Needs debugging details",
        "11": "Typo or not reproducible",
        "19": "Not written in English",
        "2": "Belongs on another site",
        "meta.stackoverflow.com": "Belongs on meta.stackoverflow.com",
        "superuser.com": "Belongs on superuser.com",
        "tex.stackexchange.com": "Belongs on text.stackexchange.com",
        "dba.stackexchange.com": "Belongs on dba.stackexchange.com",
        "stats.stackexchange.com": "Belongs on stats.stackexchange.com",
    };

    /**
     * Get question info and modify the DOM with our buttons and trinkets
     */
    pageLoadHandler() {
        // DOM is loaded, load question info into variables
        const question = document.querySelector("div#question");
        if (question === null) {
            return;
        }

        // add our button to the question
        this.requestButtonAdd(question);
        // add our button to each of the answers
        document.querySelectorAll("div#answers > div.answer")
            .forEach(answer => this.requestButtonAdd(answer));

        // wipe data during testing
        if (cvPls.ERASE_ALL_LOCAL_STORAGE && cvPls.DEBUG) {
            GM.listValues()
                .then(arr => arr.forEach(set => cvPls.log("pageLoadHandler: deleting %s", set) && GM.deleteValue(set)));
        }

        // show the revisit reminder if needed
        GM.getValue("revisits", "{}")
            .then(value => this.revisitPopoverCreate(JSON.parse(value)))
            .catch(e => cvPls.log("pageLoadHandler: error getting revisits: %s", e));

        const self = this;
        // clean up old post details
        GM.getValue("index", "{}")
            .then(function (value) {
                let i = 0;
                const obj = JSON.parse(value);
                const entries = Object.entries(obj);
                for (const [postId, time] of entries) {
                    if (time < Date.now() - (cvPls.STORE_DETAILS_FOR_DAYS * 86400000)) {
                        PostDetail.delete(postId);
                        i++;
                        delete obj[postId];
                    }
                }
                if (i > 0) {
                    cvPls.log("pageLoadHandler: queued cleanup for %d/%d stored post details", i, entries.length);
                    GM.setValue("index", JSON.stringify(obj))
                        .catch(e => cvPls.log("pageLoadHandler: error setting index: %s. Value: %o", e, obj));
                }
            })
            .catch(e => cvPls.log("pageLoadHandler: error getting index: %s", e));

        // modify the close popover
        // have to use jQuery event listener here
        $(document).on("popupLoad", function (e) {
            const popup = e.hasOwnProperty("popup") && e.popup.length ? e.popup[0] : null;
            if (popup && popup.id === "popup-close-question") {
                self.closePopupAddCheckbox(popup);
            }
        });
    }

    /**
     * Create the request button and add it to the question or answer
     *
     * @param {HTMLDivElement} container the div containing the question or answer
     */
    requestButtonAdd(container) {
        const isAnswer = container.classList.contains("answer");
        const postId = isAnswer ? container.dataset.answerid : container.dataset.questionid;
        // create the request button, copying existing formatting for close, flag, etc.
        const doc = Document.parseHTMLUnsafe(`
            <div class="flex--item">
                <button class="s-btn s-btn__link cv-pls-button" id="cv-pls-post-${postId}-trigger">${cvPls.REQUEST_BUTTON_TEXT}</button>
            </div>
        `);

        // add a click listener to fetch the request form HTML and show it in a popup
        doc.querySelector("button.cv-pls-button")
            .addEventListener("click", e => this.requestButtonClickListener(e));

        const target = isAnswer
            ? container.querySelector("button.js-flag-post-link")
            : document.querySelector("button.js-close-question-link");
        target.closest(".s-anchors").append(...doc.body.childNodes);

        // see if this is being opened due to a reminder
        PostDetail.load(postId).then(pd => pd && pd.pendingOpen && this.revisitHandle(pd));
    }

    /**
     * Handle a click of a *-pls button
     *
     * @param {MouseEvent<click>} e click event from the button
     */
    requestButtonClickListener(e) {
        const button = e.target;
        const container = button.closest("div.question, div.answer");
        const popupContainer = button.closest("div.js-post-menu")
            .querySelector("div.js-menu-popup-container");
        const isAnswer = container.classList.contains("answer");
        const postId = isAnswer ? container.dataset.answerid : container.dataset.questionid;
        const postScore = parseInt(container.dataset.score, 10);
        const isDeleted = container.classList.contains("deleted-answer");
        const postType = (isAnswer ? "a" : "q") + (isDeleted ? "d" : "");
        const askedDate = Date.parse(document.querySelector("time[itemprop='dateCreated']")?.dateTime);
        const ageDays = Math.floor((Date.now() - askedDate) / 86400000);
        const questionOpen = document.querySelector("button.js-close-question-link[data-is-closed=false]") !== null;
        const closedDate = questionOpen
            ? 0
            : Date.parse(document.querySelector("aside.s-notice span.relativetime")?.getAttribute("title") ?? null);
        const closedDays = closedDate ? Math.floor((Date.now() - (closedDate)) / 86400000) : -1;
        const modifiedDate = Date.parse(
            document.querySelector("a[href='?lastactivity']")?.getAttribute("title") ?? ""
        );
        const activeDays = Math.floor((Date.now() - (modifiedDate || 0)) / 86400000);
        const self = this;

        // we use the jQuery popup plugin, in the same way as the native close vote form
        $(e.target).loadPopup({
            html: this.requestPopoverMarkupCreate(postType, postId, postScore, ageDays, activeDays, closedDays),
            target: $(popupContainer),
        }).then(function () {
            const reason = document.querySelector("select#cv-pls-reason");
            // popup is ready, add listeners for the form elements to update details with each change
            reason.addEventListener("change", e => self.requestPopoverUpdate(e));
            // select close reason by letter
            reason.addEventListener("keyup", function (e) {
                /** @var {HTMLSelectElement} reason */
                const reason = e.target;
                const letter = e.key;
                const opt = reason.querySelector(`option[data-letter=${letter}]`);
                if (opt) {
                    opt.selected = true;
                    self.requestPopoverUpdate(e);
                    document.querySelector("#cv-pls-details").focus();
                }
            });

            const details = document.querySelector("#cv-pls-details");
            details.addEventListener("keyup", e => self.requestPopoverUpdate(e));

            document.querySelector("#cv-pls-type").addEventListener("change", function (e) {
                self.requestPopoverUpdate(e);
                if (this.value === "revisit-x") {
                    const days = document.querySelector("#cv-pls-revisit-days");
                    days.value = "";
                    days.focus();
                } else if (this.value === "flag-pls") {
                    document.querySelector("#flag-pls-reason").focus();
                } else if (reason.disabled === false) {
                    reason.focus();
                } else {
                    details.focus();
                }
            });

            const flagReason = document.querySelector("#flag-pls-reason");
            flagReason.addEventListener("change", function (e) {
                self.requestPopoverUpdate(e);
                details.focus();
            });

            document.querySelector("#cv-pls-nato").addEventListener("change", e => self.requestPopoverUpdate(e));

            document.querySelector("#cv-pls-copy").addEventListener("click", function () {
                navigator.clipboard.writeText(document.querySelector("#cv-pls-request").value)
                    .then(function () {
                        return StackExchange.helpers.showToast("Copied", {type: "success", transientTimeout: 2000});
                    });
            });

            document.querySelector("#cv-pls-submit").addEventListener("click", () => self.requestSend());

            self.requestPopoverUpdate();

            // if there are already details in local storage for this post, populate the form elements
            PostDetail.load(postId)
                .then(pd => pd && pd.populateForm())
                .catch(e => cvPls.log("requestButtonClickListener: error getting post %s: %s", postId, e));

            PostDetail.lastRequested(postId)
                .then(function (lastReq) {
                    if (lastReq === undefined) {
                        return;
                    }
                    const dt = new Date(lastReq.time);
                    document.getElementById("cv-pls-last-type").textContent = lastReq.type;
                    document.getElementById("cv-pls-last-time").textContent = dt.toLocaleString();
                    document.getElementById("cv-pls-last-request").classList.remove("d-none");
                });
            if (reason.disabled) {
                details.focus();
            } else {
                reason.focus();
            }
        });
    }

    /**
     * Check for pending revisits and show the reminder popover
     *
     * @param {Object} revisits
     */
    revisitPopoverCreate(revisits) {
        const revisitEntries = Object.entries(revisits).filter(e => e[1] < Date.now());
        if (revisitEntries.length === 0) {
            return;
        }
        cvPls.log("revisitPopoverCreate: processing %d revisits: %o", revisitEntries.length, revisitEntries);
        const target = document.querySelector("#question button.cv-pls-button");
        // build the revisit popover per https://stackoverflow.design/product/components/popovers/
        const doc = Document.parseHTMLUnsafe(`
            <div class="s-popover px16 s-anchors s-anchors__default is-visible mt8" role="menu" data-popper-placement="bottom">
                <p class="bold mb4">Revisit Posts</p>
                <p class="mb12">You have ${revisitEntries.length} ${revisitEntries.length === 1 ? "post" : "posts"} due for revisiting.</p>
                <p class="mb0">
                    <button id="cv-pls-revisit-now" class="s-btn s-btn__filled mr8" type="button">Open</button>
                    <button id="cv-pls-revisit-cancel" class="s-btn s-btn__link" type="button" aria-label="Close">Cancel</button>
                </p>
                <div class="s-popover--arrow"></div>
            </div>
        `);
        doc.getElementById("cv-pls-revisit-cancel").addEventListener("click", function () {
            this.closest(".s-popover").classList.remove("is-visible");
        });
        doc.getElementById("cv-pls-revisit-now").addEventListener("click", function () {
            // find posts that are due, mark them as having a pending open, open them, and then remove them from the revisit list
            for (const [postId] of revisitEntries) {
                PostDetail.load(postId)
                    .then(function (pd) {
                        pd.save({pendingOpen: true}).then(() => GM.openInTab(pd.url, true));
                    })
                    .catch(e => cvPls.log("revisitPopoverCreate: error getting post %s: %s", postId, e));
                delete revisits[postId];
            }
            // hide the popover
            this.closest(".s-popover").classList.remove("is-visible");
            // save the updated revisit list
            GM.setValue("revisits", JSON.stringify(revisits))
                .then(() => cvPls.log("revisitPopoverCreate: saved revisits. Value: %o", revisits))
                .catch(e => cvPls.log("revisitPopoverCreate: error setting revisits: %s. Value: %o", e, revisits));
        });
        target.after(...doc.body.childNodes);
    }

    /**
     * A revisit: auto-open the request popover and show a banner on the page
     *
     * @param {PostDetail} pd
     */
    revisitHandle(pd) {
        pd.save({pendingOpen: false});
        const button = document.getElementById(`cv-pls-post-${pd.id}-trigger`);
        button.dispatchEvent(new MouseEvent("click"));

        if (document.getElementById("cv-pls-banner")) {
            // just in case there are multiple revisits pending
            return;
        }
        // build the banner per https://stackoverflow.design/product/components/banners/
        const banner = Document.parseHTMLUnsafe(`
            <div id="cv-pls-banner" class="s-banner s-banner__important is-pinned" role="alert" aria-hidden="false" data-controller="s-banner" data-s-banner-target="banner">
                <div class="s-banner--container d-flex flex__center jc-space-between p0" role="alertdialog">
                    <div class="flex-item fw-bold fs-body3 p0">
                        Page reopened by cv-pls generator
                    </div>
                    <div class="flex--item ml-auto myn8 p0">
                        <button type="button" id="cv-pls-banner-close" class="s-btn s-banner--btn" aria-label="Dismiss" data-toggle="s-banner" data-target="#cv-pls-banner">
                            <svg aria-hidden="true" class="svg-icon iconClearSm m0" width="14" height="14" viewBox="0 0 14 14"><path d="M12 3.41 10.59 2 7 5.59 3.41 2 2 3.41 5.59 7 2 10.59 3.41 12 7 8.41 10.59 12 12 10.59 8.41 7z"></path></svg>
                        </button>
                    </div>
                </div>
            </div>
        `);
        // wire up the banner close button
        banner.getElementById("cv-pls-banner-close").addEventListener("click", function (e) {
            e.stopPropagation();
            const banner = document.querySelector(this.dataset.target);
            Stacks.hideBanner(banner);
        });
        document.getElementById("notify-container").append(...banner.body.childNodes);
    }

    /**
     * Store a reminder in local storage to revisit a post
     *
     * @param {String} postId the post ID
     * @param {String} days when to revisit
     */
    revisitSave(postId, days) {
        // in debug mode we do minutes not days
        const revisitTime = Date.now() + (parseInt(days, 10) * (cvPls.DEBUG ? 60000 : 86400000));
        cvPls.log("Adding new revisit reminder for post %s: %s", postId, new Date(revisitTime));
        // append the new reminder to the existing revisit list
        GM.getValue("revisits", "{}")
            .then(function (value) {
                let setting = JSON.parse(value);
                setting[postId] = revisitTime;
                // save the revisit and show the result to the user
                // https://stackoverflow.design/product/components/notices/#toast
                GM.setValue("revisits", JSON.stringify(setting))
                    .then(function () {
                        StackExchange.helpers.showToast("Reminder saved", {type: "success", transientTimeout: 2000});
                        StackExchange.helpers.closePopups("#cv-pls-popup");
                        cvPls.log("revisitSave: saved revisits. Value: %o", setting);
                    })
                    .catch(function (e) {
                        StackExchange.helpers.showToast("Error saving", {type: "danger", transientTimeout: 2000});
                        cvPls.log("revisitSave: error setting revisits: %s. Value: %o", e, setting);
                    });
            })
            .catch(function (e) {
                StackExchange.helpers.showToast("Error loading settings", {type: "danger", transientTimeout: 2000});
                cvPls.log("revisitSave: error getting revisits: %s", e);
            });
    }

    /**
     * Alter the Stack Overflow close popover so we can send requests from it
     *
     * @param {HTMLDivElement} popover the popover body
     */
    closePopupAddCheckbox(popover) {
        const cvCount = parseInt(document.querySelector("button.js-close-question-link span.existing-flag-count")?.textContent ?? 0, 10);
        cvPls.log("%d close votes", cvCount);
        // build a checkbox and append it to the bottom of the form
        // but only if there are 0 or 1 close votes (but not yours)
        // 2 votes means you'll be the closing vote, so no request is needed
        if (cvCount < 2) {
            const doc = Document.parseHTMLUnsafe(`
                <div class="flex--item d-flex ai-center ml16 gx8">
                    <div class="flex--item">
                        <input type="checkbox" id="cv-pls-close" class="s-checkbox"/>
                    </div>
                    <div class="flex--item">
                        <label for="cv-pls-close" class="d-block s-label">Send cv-pls?</label>
                    </div>
                    <div class="flex--item">
                        <input type="checkbox" id="cv-pls-close-nato" class="s-checkbox" disabled="disabled"/>
                    </div>
                    <div class="flex--item">
                        <label for="cv-pls-close-nato" class="d-block s-label">NATO?</label>
                    </div>
                </div>
            `);
            popover.querySelector("div.popup-actions > div.d-flex > span.flex--item")
                ?.before(...doc.body.childNodes);
            document.getElementById("cv-pls-close")
                .addEventListener("change", function (e) {
                    document.getElementById("cv-pls-close-nato").disabled = !e.target.checked;
                });
        }

        // listen for the close form submission
        popover.querySelector("form")
            .addEventListener("submit", e => this.closePopupSubmitListener(e));
    }

    /**
     * @param {SubmitEvent} e
     */
    closePopupSubmitListener(e) {
        /** @var {HTMLFormElement} */
        const form = e.target;
        const questionId = document.querySelector("div#question").dataset.questionid;
        const reason = form.closeReasonId.value;
        const ssReason = form.siteSpecificCloseReasonId?.value;
        const migrateTarget = form.belongsOnBaseHostAddress?.value;
        const customReason = (form.siteSpecificOtherText?.textContent ?? "")
            .replace(form.originalSiteSpecificOtherText.value, "");

        let reasonCode;
        let reasonText;
        if (cvPls.CLOSE_REASON_TEXT.hasOwnProperty(reason)) {
            reasonCode = reason;
            reasonText = cvPls.CLOSE_REASON_TEXT[reason];
        } else if (cvPls.CLOSE_REASON_TEXT.hasOwnProperty(ssReason)) {
            reasonCode = ssReason;
            reasonText = cvPls.CLOSE_REASON_TEXT[ssReason];
        } else if (cvPls.CLOSE_REASON_TEXT.hasOwnProperty(migrateTarget)) {
            reasonCode = migrateTarget;
            reasonText = cvPls.CLOSE_REASON_TEXT[migrateTarget];
        } else {
            reasonCode = null;
            reasonText = null;
        }

        // build the object and save it into local storage for any close vote
        const postDetails = new PostDetail;
        postDetails.save({
            id: questionId,
            time: Date.now(),
            type: "q",
            url: `https://stackoverflow.com/q/${questionId}`,
            lastRequestType: "cv-pls",
            reason: reasonText ?? "",
            reasonCode: reasonCode,
            details: customReason,
            nato: document.querySelector("#cv-pls-close-nato")?.checked ?? false
        })
            .then(() => cvPls.log("closePopupSubmitListener: saved post %s. Value: %o", questionId, postDetails))
            .catch(e => cvPls.log("closePopupSubmitListener: error saving post %s: %s. Value: %o", questionId, e, postDetails));

        if (!document.querySelector("#cv-pls-close")?.checked) {
            return;
        }

        // and if the box is checked, also send the request
        reasonText = reasonText ?? customReason;
        if (reasonText.length > 0) {
            if (document.querySelector("#cv-pls-close-nato")?.checked) {
                reasonText += " (NATO)";
            }
            const modifiedDate = Date.parse(
                document.querySelector("a[href='?lastactivity']")?.getAttribute("title") ?? ""
            );
            const activeDays = Math.floor((Date.now() - (modifiedDate || 0)) / 86400000);

            const requestText = this.requestBodyCreate("cv-pls", reasonText, questionId);
            const requestRoom = activeDays > cvPls.OLD_ROOM_DAYS ? cvPls.SOCVR_OLD_ROOM : cvPls.SOCVR_ROOM;
            postDetails.logRequest();
            this.requestSend(requestRoom, requestText);
        }
    }

    /**
     * Update the request, preview, room info as changes are made to the form
     */
    requestPopoverUpdate() {
        const reason = document.querySelector("#cv-pls-reason");
        const flagReason = document.querySelector("#flag-pls-reason");
        const details = document.querySelector("#cv-pls-details");
        const type = document.querySelector("#cv-pls-type");
        const nato = document.querySelector("#cv-pls-nato");
        const room = document.querySelector("#cv-pls-room");
        const roomText = document.querySelector("#cv-pls-room-text");
        const preview = document.querySelector("#cv-pls-preview");
        const request = document.querySelector("#cv-pls-request");
        const submit = document.querySelector("#cv-pls-submit");
        const copy = document.querySelector("#cv-pls-copy");
        const popup = document.querySelector("#cv-pls-popup");
        const isQuestion = popup.dataset.postType.startsWith("q");

        // reset some elements as needed
        preview.innerHTML = "";
        request.value = "";
        reason.disabled = !isQuestion || !/^(cv-pls|del-pls|revisit-)/.test(type.value);
        flagReason.disabled = (type.value !== "flag-pls");
        nato.disabled = !isQuestion || !/^(cv-pls|revisit-)/.test(type.value);
        if (nato.disabled) {
            nato.checked = false;
        }

        const postId = popup.dataset.postId;
        const url = isQuestion
            ? `https://stackoverflow.com/q/${postId}`
            : `https://stackoverflow.com/a/${postId}`;

        // save the request details into the DOM, only stored into local storage on send
        popup.dataset.postDetails = JSON.stringify({
            id: postId,
            time: Date.now(),
            type: isQuestion ? "q" : "a",
            url: url,
            lastRequestType: type.value,
            reasonCode: reason.value,
            details: details.value,
            nato: nato.checked,
        });
        popup.dataset.postUrl = url;

        let fullReason = "";
        if (!reason.disabled && reason.selectedOptions.length) {
            fullReason += reason.selectedOptions.item(0).textContent;
        }
        if (details.value.length > 0) {
            if (fullReason.length > 0) {
                fullReason += " - "
            }
            fullReason += details.value;
        }

        if (
            (!type.value.startsWith("revisit") && type.value !== "flag-pls" && fullReason.length === 0)
            // flag-pls can be empty but only if spam or offensive reason is chosen
            || (type.value === "flag-pls" && flagReason.value === "" && fullReason.length === 0)
        ) {
            // standard request with no content
            copy.disabled = true;
            submit.disabled = true;
        } else if (type.value.startsWith("revisit")) {
            // revisit request is allowed to be empty
            copy.disabled = true;
            submit.disabled = false;
        } else {
            copy.disabled = (navigator.clipboard === undefined);
            submit.disabled = false;
        }

        const revisit = type.value.match(/^revisit-(\d+|x)/);
        if (revisit !== null) {
            if (revisit[1] === "x") {
                document.querySelector("#cv-pls-days-container").classList.replace("d-none", "d-flex");
            } else {
                document.querySelector("#cv-pls-days-container").classList.replace("d-flex", "d-none");
                const days = document.querySelector("#cv-pls-revisit-days");
                days.value = revisit[1];
            }
        } else {
            document.querySelector("#cv-pls-days-container").classList.replace("d-flex", "d-none");
        }

        let newRoom;
        if (type.value.startsWith("revisit") || type.value === "cv-pls") {
            newRoom = type.dataset.defaultRoom;
            nato.disabled = false;
            if (nato.checked) {
                fullReason += " (NATO)";
            }
            document.querySelector("#flag-pls-reason-container").classList.replace("d-flex", "d-none");
            document.querySelector("#cv-pls-reason-container").classList.replace("d-none", "d-flex");
        } else {
            newRoom = cvPls.SOCVR_ROOM;
            nato.checked = false;
            nato.disabled = true;
            if (type.value === "flag-pls") {
                document.querySelector("#flag-pls-reason-container").classList.replace("d-none", "d-flex");
                document.querySelector("#cv-pls-reason-container").classList.replace("d-flex", "d-none");
            } else {
                document.querySelector("#flag-pls-reason-container").classList.replace("d-flex", "d-none");
                document.querySelector("#cv-pls-reason-container").classList.replace("d-none", "d-flex");
            }
        }
        room.value = newRoom;

        if (revisit === null && submit.disabled === false) {
            // standard request, build a preview
            let reqType = type.value;
            let tag = document.querySelector("div.post-taglist a.post-tag")?.textContent ?? "";
            if (reqType === "flag-pls") {
                tag = "";
                if (flagReason.value) {
                    reqType = flagReason.value;
                }
            } else if (tag.length) {
                tag = `<span class="s-tag">${tag}</span>`;
            }
            request.value = this.requestBodyCreate(reqType, fullReason, postId, isQuestion);
            let title = document.querySelector("a.question-hyperlink").innerHTML;
            title = title.replace(/ \[(duplicate|closed)\]$/, "");
            if (!isQuestion) {
                title = `Answer to: ${title}`;
            }
            roomText.textContent = `Sending to ${newRoom === cvPls.SOCVR_ROOM ? "SOCVR" : "SOCVR old questions"}`;

            const doc = Document.parseHTMLUnsafe(`
                <span class="s-tag">${reqType}</span>
                ${tag}
                ${fullReason}
                <a href="${url}">${title}</a>
            `);
            preview.append(...doc.body.childNodes);
        } else {
            // revisit request, no preview
            roomText.textContent = "";
            copy.disabled = true;
        }
    }

    /**
     * Send the request to a chat room
     *
     * @param {String?} roomId the room, pulled from form element if not provided
     * @param {String?} requestText the request, pulled from form element if not provided
     */
    requestSend(roomId, requestText) {
        const popup = document.querySelector("#cv-pls-popup");
        // save the request, but only if submitted from our popup; otherwise it's already saved
        if (popup && popup.dataset.postDetails) {
            const obj = JSON.parse(popup.dataset.postDetails);
            const postDetail = Object.assign(new PostDetail, obj);
            postDetail.save()
                .then(() => cvPls.log("requestSend: saved post %s. Value: %o", postDetail.id, postDetail))
                .catch(e => cvPls.log("requestSend: error saving post %s: %s. Value: %o", postDetail.id, e, postDetail));
            const requestType = document.querySelector("#cv-pls-type");
            if (requestType.value.startsWith("revisit")) {
                this.revisitSave(postDetail.id, popup.querySelector("#cv-pls-revisit-days")?.value);
                return;
            }
            postDetail.logRequest(postDetail.lastRequestType);
        }
        // these are only filled when the stock close popup is submitted with the checkbox
        requestText ??= document.querySelector("#cv-pls-request").value;
        roomId ??= document.querySelector("#cv-pls-room").value;
        if (cvPls.DEBUG) {
            roomId = cvPls.SANDBOX_ROOM;
        }

        const roomUrl = `https://chat.stackoverflow.com/rooms/${roomId}`;
        const chatUrl = `https://chat.stackoverflow.com/chats/${roomId}/messages/new`;

        // if the popup isn't loaded, create a fake element
        const submit = document.querySelector("#cv-pls-submit") ?? document.createElement("button");
        submit.ariaBusy = "true";
        submit.disabled = true;
        submit.classList.add("is-loading");
        // get a key to allow us to submit the chat request
        GM.xmlHttpRequest({
            method: "GET",
            url: roomUrl,
            onload: function (resp) {
                const fkeyDoc = Document.parseHTMLUnsafe(resp.responseText);
                /** @var {HTMLInputElement} */
                const fkeyInput = fkeyDoc.getElementById("fkey");
                if (fkeyInput === null) {
                    submit.classList.remove("is-loading");
                    submit.disabled = false;
                    submit.ariaBusy = "false";
                    StackExchange.helpers.showToast(
                        "Couldn't find fkey in response",
                        {type: "danger", transientTimeout: 2000}
                    );
                    cvPls.log("requestSend: retrieved document without fkey: %o", fkeyDoc);
                    return;
                }
                const fkey = fkeyInput.value;
                // we have the fkey, now send the request
                GM.xmlHttpRequest({
                    method: "POST",
                    url: chatUrl,
                    data: `text=${encodeURIComponent(requestText)}&fkey=${encodeURIComponent(fkey)}`,
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded"
                    },
                    onload: function () {
                        StackExchange.helpers.showToast("Request sent", {type: "success", transientTimeout: 2000});
                        StackExchange.helpers.closePopups("#cv-pls-popup");
                    },
                    onerror: function (resp) {
                        submit.classList.remove("is-loading");
                        submit.disabled = false;
                        submit.ariaBusy = "false";
                        StackExchange.helpers.showToast(
                            `Request send failed: ${resp.status} ${resp.statusText}`,
                            {type: "danger", transientTimeout: 2000}
                        );
                        cvPls.log("requestSend: error %d sending request: %o", resp.status, resp);
                    }
                });
            },
            onerror: function (/** @param {XMLHttpRequest} */resp) {
                submit.classList.remove("is-loading");
                submit.disabled = false;
                submit.ariaBusy = "false";
                StackExchange.helpers.showToast(
                    `fkey request failed: ${resp.status} ${resp.statusText}`,
                    {type: "danger", transientTimeout: 2000}
                );
                cvPls.log("requestSend: error %d fetching fkey: %o", resp.status, resp);
            }
        });
    }

    /**
     * Build a chat message for sending
     *
     * @param {String} type
     * @param {String} reason
     * @param {String} postId
     * @param {Boolean} isQuestion
     */
    requestBodyCreate(type, reason, postId, isQuestion = true) {
        let tag = "";
        if (type !== "flag-pls") {
            tag = document.querySelector("div.post-taglist a.post-tag")?.textContent ?? "";
            if (tag.length) {
                tag = ` [tag:${tag}]`;
            }
        }
        let title = document.querySelector("a.question-hyperlink")?.textContent ?? "";
        title = title.replace(/ \[(closed|duplicate)]$/, "")
            .replaceAll(/\[/g, "\\[")
            .replaceAll(/]/g, "\\]");
        if (!isQuestion) {
            title = `Answer to: ${title}`;
        }
        const url = isQuestion
            ? `https://stackoverflow.com/q/${postId}`
            : `https://stackoverflow.com/a/${postId}`;

        return `[tag:${type}]${tag} ${reason} [${title}](${url})`;
    }

    /**
     * build the HTML markup for the popup
     *
     * @param {String} postType "q", "qd", "a", "ad" (question/answer, deleted)
     * @param {String} postId
     * @param {Number} postScore
     * @param {Number} ageDays how old the question is
     * @param {Number} activeDays days since last activity on the question
     * @param {Number} closedDays if a closed question, days since closure, -1 otherwise
     */
    requestPopoverMarkupCreate(postType, postId, postScore, ageDays, activeDays, closedDays) {
        const isOpen = closedDays < 0;
        const cvOpt = "<option value='cv-pls'>Close</option>";
        const rvOpt = "<option value='reopen-pls'>Reopen</option>";
        const dvOpt = "<option value='del-pls'>Delete</option>";
        const uvOpt = "<option value='undel-pls'>Undelete</option>";
        const flOpt = "<option value='flag-pls'>Flag</option>";
        let reOpt = `
            <option value='revisit-2'>Revisit in 2 days</option>
            <option value='revisit-7'>Revisit in 7 days</option>
            <option value='revisit-14'>Revisit in 14 days</option>
            <option value='revisit-x'>Revisit in X days</option>
        `;
        if (cvPls.DEBUG) {
            reOpt = reOpt.replace(/days/gm, "minutes");
        }
        let opts = "";
        let room = cvPls.SOCVR_ROOM;
        switch (postType) {
            case "qd":
            case "ad":
                opts = uvOpt + flOpt;
                break;
            case "q":
                opts = isOpen
                    ? cvOpt + flOpt
                    : (closedDays >= 2 || postScore <= -3 ? dvOpt : "") + rvOpt + flOpt;
                room = isOpen && activeDays > cvPls.OLD_ROOM_DAYS ? cvPls.SOCVR_OLD_ROOM : cvPls.SOCVR_ROOM;
                break;
            case "a":
                opts = (postScore <= 0 ? dvOpt : "") + flOpt + (postType === "ad" ? uvOpt : "");
                break;
        }
        opts += reOpt;

        return `
            <div
                id="cv-pls-popup"
                class="popup responsively-horizontally-centered-legacy-popup z-modal ws6"
                role="dialog"
                data-controller="se-draggable"
                data-post-type="${postType}"
                data-post-id="${postId}"
                data-post-score="${postScore}"
            >
                <div class="popup-close" aria-controls="#cv-pls-popup">
                    <a title="close this popup (or hit Esc)">×</a>
                </div>
                <div class="cv-pls-header">
                    <h2 class="popup-title-container c-move fs-title" data-se-draggable-target="handle">
                        <span class="popup-title ${cvPls.DEBUG ? "fc-danger" : ""}">
                            Send request${cvPls.DEBUG ? " to sandbox" : ""}…
                        </span>
                    </h2>
                </div>
                <div id="pane-main" class="cv-pls-body popup-pane popup-active-pane">

                    <div class="d-flex gy4 my8 fd-column">
                        <label for="cv-pls-type" class="flex--item s-label">Request Type</label>
                        <div class="flex--item s-select">
                            <select id="cv-pls-type" data-default-room="${room}">
                                ${opts}
                            </select>
                        </div>
                    </div>

                    <div class="d-flex gy4 my8 fd-column d-none" id="cv-pls-days-container">
                        <label for="cv-pls-days" class="flex--item s-label">Revisit Days</label>
                        <input type="number" id="cv-pls-revisit-days" class="flex--item s-input"/>
                    </div>

                    <div class="d-flex gy4 my8 fd-column" id="cv-pls-reason-container">
                        <label for="cv-pls-reason" class="flex--item s-label">Close/Delete Reason</label>
                        <div class="flex--item s-select">
                            <select id="cv-pls-reason" ${postType !== "q" ? "disabled" : ""}>
                                <option></option>
                                <option value="Duplicate" data-letter="d">${cvPls.CLOSE_REASON_TEXT["Duplicate"]}</option>
                                <option value="NeedsDetailsOrClarity" data-letter="c">${cvPls.CLOSE_REASON_TEXT["NeedsDetailsOrClarity"]}</option>
                                <option value="NeedMoreFocus" data-letter="f">${cvPls.CLOSE_REASON_TEXT["NeedMoreFocus"]}</option>
                                <option value="OpinionBased" data-letter="o">${cvPls.CLOSE_REASON_TEXT["OpinionBased"]}</option>
                                <option value="18" data-letter="n">${cvPls.CLOSE_REASON_TEXT["18"]}</option>
                                <option value="16" data-letter="l">${cvPls.CLOSE_REASON_TEXT["16"]}</option>
                                <option value="13" data-letter="m">${cvPls.CLOSE_REASON_TEXT["13"]}</option>
                                <option value="11" data-letter="r">${cvPls.CLOSE_REASON_TEXT["11"]}</option>
                                <option value="19" data-letter="e">${cvPls.CLOSE_REASON_TEXT["19"]}</option>
                                ${ageDays < 60 ? `<option value="2" data-letter="b">${cvPls.CLOSE_REASON_TEXT["2"]}</option>` : ""}
                            </select>
                        </div>
                    </div>

                    <div class="d-none gy4 my8 fd-column" id="flag-pls-reason-container">
                        <label for="flag-pls-reason" class="flex--item s-label">Flag Reason</label>
                        <div class="flex--item s-select">
                            <select id="flag-pls-reason">
                                <option value="">Other</option>
                                <option value="spam">Spam</option>
                                <option value="offensive">Rude/Abusive</option>
                            </select>
                        </div>
                    </div>

                    <div class="d-flex gy4 my8 fd-column">
                        <label for="cv-pls-details" class="flex--item s-label">Additional Details</label>
                        <input type="text" id="cv-pls-details" class="flex--item s-input"/>
                    </div>

                    <div class="d-flex gy4 my8">
                        <div class="flex--item">
                            <input type="checkbox" id="cv-pls-nato" disabled="disabled" class="s-checkbox"/>
                        </div>
                        <label for="cv-pls-nato" class="flex--item s-label">
                            <abbr title="New Answer to Old Question">NATO</abbr>
                        </label>
                    </div>

                    <div id="cv-pls-preview" class="my8"></div>

                    <div id="cv-pls-last-request" class="my8 d-none">
                        <span id="cv-pls-last-type"></span> request sent <span id="cv-pls-last-time"></span>
                    </div>

                    <div class="popup-actions mt12">
                        <div class="d-flex gx8 ai-center">
                            <input type="hidden" id="cv-pls-request"/>
                            <input type="hidden" id="cv-pls-room" value="${room}"/>
                            <button
                                type="button"
                                disabled="disabled"
                                id="cv-pls-submit"
                                class="s-btn s-btn__filled flex--item ${cvPls.DEBUG ? " s-btn__danger" : ""}"
                            >Submit</button>
                            <button type="button" class="s-btn flex--item js-popup-close">Cancel</button>
                            <div class="flex--item ml-auto ta-right">
                                <span id="cv-pls-room-text" class="ml-auto fc-black-400">
                                    Sending to ${room === cvPls.SOCVR_ROOM ? "SOCVR" : "SOCVR old questions"}
                                </span><br/>
                                <button id="cv-pls-copy" disabled="disabled" class="s-btn s-btn__link">
                                    Copy request
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * debug logging
     *
     * @param {String} message
     * @param {*} args
     * @return {void}
     */
    static log(message, ...args) {
        (cvPls.DEBUG || cvPls.ENABLE_LOG) && console.log(message, ...args);
    }
}

/**
 * A class to hold information about and functions related to a post
 */
class PostDetail {
    /** @var {String} id the post ID */
    id;
    /** @var {Number} time the time of the request */
    time;
    /** @var {String} type the type of the post (q or a) */
    type;
    /** @var {String} url the URL of the post */
    url;
    /** @var {String} requestType the type of the request (e.g. cv-pls) */
    lastRequestType;
    /** @var {String} reason the text of the request reason (e.g. Needs more focus) */
    reason;
    /** @var {String|null} reasonCode the request reason code (e.g. NeedMoreFocus) */
    reasonCode;
    /** @var {String} details additional request text */
    details;
    /** @var {Boolean} nato whether this is a new answer to an old question */
    nato;
    /** @var {Boolean} pendingOpen whether this post's URL is being opened automatically for revisit */
    pendingOpen = false;

    /**
     * Given an ID, pull data and hydrate this object
     *
     * @param {String} id
     * @return {Promise<PostDetail|void>}
     */
    static load(id) {
        return GM.getValue(`post-${id}`)
            .then(function (v) {
                if (typeof v === "string" || v instanceof String) {
                    const obj = JSON.parse(v);
                    if (obj) {
                        cvPls.log("PostDetail.load: loaded post %s: %o", id, obj);
                        return Object.assign(new PostDetail, obj);
                    }
                }
            })
            .catch(e => cvPls.log("PostDetail.load: error loading post %s: %s", id, e));
    }

    /**
     * Given an ID, remove the data (index must be updated separately)
     *
     * @param {String} id
     * @return {Promise<void>}
     */
    static delete(id) {
        return GM.deleteValue(`post-${id}`)
            .then(() => cvPls.log("PostDetail.delete: deleted post %s", id))
            .catch(e => cvPls.log("PostDetail.delete: error deleting post %s: %s", id, e));
    }

    /**
     * Given an ID, get details of the last request sent
     *
     * @param {String} id
     * @return {Promise<Object|void>}
     */
    static lastRequested(id) {
        return GM.getValue("requestIndex", "{}")
            .then(function (value) {
                const idx = JSON.parse(value);
                if (idx.hasOwnProperty(id)) {
                    return idx[id];
                }
            });
    }

    /**
     * Fill some form values based on the object's values
     */
    populateForm() {
        /** @var {HTMLSelectElement} */
        const reason = document.querySelector("#cv-pls-reason");
        if (this.reasonCode) {
            reason.value = this.reasonCode;
            for (const option of reason) {
                if (option.value === this.reasonCode) {
                    option.selected = true;
                }
            }
        }
        document.querySelector("#cv-pls-details").value = this.details;
        document.querySelector("#cv-pls-nato").checked = this.nato;
        document.querySelector("#cv-pls-type").dispatchEvent(new InputEvent("change"));
    }

    /**
     * Save this object into local storage
     *
     * @param {Object} updates property/value pairs to update before saving
     * @return {Promise<String|void>}
     */
    save(updates = {}) {
        const now = Date.now();
        const id = this.id;
        GM.getValue("index", "{}")
            .then(function (value) {
                const idx = JSON.parse(value);
                idx[id] = now;

                return GM.setValue("index", JSON.stringify(idx));
            });
        for (const[k, v] of Object.entries(updates)) {
            this[k] = v;
        }

        return GM.setValue(`post-${this.id}`, JSON.stringify(this));
    }

    /**
     * Save type and time of the most recent request made for the post
     *
     * @param {String} type the request type cv-pls, del-pls, etc.
     * @return {Object} an object with type and time properties
     */
    logRequest(type = "cv-pls") {
        const now = Date.now();
        const id = this.id;
        GM.getValue("requestIndex", "{}")
            .then(function (value) {
                const idx = JSON.parse(value);
                const data = {type: type, time: now};
                idx[id] = data;

                return GM.setValue("requestIndex", JSON.stringify(idx))
                    .then(() => cvPls.log("PostDetail.logRequest: saved post %s: %o", id, data))
                    .catch(e => cvPls.log("PostDetail.logRequest: error saving post %s: %s", id, e));
            });
    }
}
