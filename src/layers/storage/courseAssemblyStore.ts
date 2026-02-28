import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AssembledCourse,
  CourseAssessmentPlan,
  CourseRoadmap,
  GeneratedLesson
} from "../../domain/models.js";
import { createId, slugify } from "../../utils/text.js";

export class CourseAssemblyStore {
  constructor(private readonly outputDirectory: string) {}

  assembleCourse(
    roadmap: CourseRoadmap,
    lessons: GeneratedLesson[],
    assessments: CourseAssessmentPlan
  ): AssembledCourse {
    return {
      id: createId("course", roadmap.courseTitle),
      title: roadmap.courseTitle,
      roadmap,
      lessons,
      assessments,
      createdAt: new Date().toISOString(),
      navigation: roadmap.chapters.map((chapter) => ({
        chapterId: chapter.id,
        lessonIds: lessons
          .filter((lesson) => lesson.chapterId === chapter.id)
          .map((lesson) => lesson.id)
      }))
    };
  }

  async persistCourse(course: AssembledCourse): Promise<string> {
    const coursesDirectory = path.join(this.outputDirectory, "courses");
    await mkdir(coursesDirectory, { recursive: true });

    const filePath = path.join(coursesDirectory, `${slugify(course.title)}.json`);
    await writeFile(filePath, JSON.stringify(course, null, 2), "utf8");

    return filePath;
  }
}
