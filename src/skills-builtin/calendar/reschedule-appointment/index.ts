import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { rescheduleAppointmentMutation } from "../../../tools/calendar/reschedule-appointment.mutation.js";

export default {
  execute: mutationExecute(rescheduleAppointmentMutation),
};
