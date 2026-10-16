import { Chant, init } from "neuma";
import { SAMPLE } from "./sample";
import { Score } from "./score";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

await init();
new Score(byId("score"), new Chant(SAMPLE));
