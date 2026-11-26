import { form } from "./_util.mjs";
// A required text field whose own check is an async stage that declares its path (`remote:name`,
// host/entry.ts), held pending until the case answers it. The field is refused once (by the whole-form
// check) so that the form's default `validateOn` checks the path again as its answer is committed; that
// second check is the one that draws the pending state.
export default {
  id: "pending", title: "A required text field with an async check on its path",
  definition: form([
    { id: "name", type: "text", configuration: { label: "Full name", description: "As on your passport.", required: true } }
  ]),
  stages: ["remote:name"]
};
